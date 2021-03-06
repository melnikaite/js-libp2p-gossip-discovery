const Buffer = require('safe-buffer').Buffer
const EventEmitter = require('events').EventEmitter
const PeerInfo = require('peer-info')
const PeerId = require('peer-id')
const pull = require('pull-stream')
const Pushable = require('pull-pushable')
const Reader = require('pull-reader')
const debug = require('debug')
const leb = require('pull-leb128')
const log = debug('discovery:gossip')
debug.enable('discovery:gossip')

const PROTO = '/discovery/gossip/0.0.0'

module.exports = class handlePeers extends EventEmitter {
  /**
   * @param {Number} targetNumberOfPeers - the max number of peers to add to the peer book
   */
  constructor (targetNumberOfPeers) {
    super()
    this.targetNumberOfPeers = targetNumberOfPeers
    this._onConnection = this._onConnection.bind(this)
  }

  /**
   * Attach an instance of libp2p to the discovery instance
   * @param {Object} node - the libp2p instance
   */
  attach (node) {
    this.node = node
  }

  /**
   * starts the gossip process, this is called by libp2p but if you are using
   * this standalone then this needs to be called
   * @param {Function} cb - a callback
   */
  start (cb) {
    const node = this.node
    node.handle(PROTO, (proto, conn) => {
      const p = Pushable()
      pull(p, conn)

      let peers = peerBookToJson(node.peerBook)

      if (Object.keys(peers).length === 0) {
        leb.unsigned.write(0, p)
      } else {
        peers = Buffer.from(JSON.stringify(peers))
        leb.unsigned.write(peers.length, p)
        p.push(peers)
      }
      p.end()
    })
    this.peerDiscovery(this.targetNumberOfPeers)
    cb()
  }

  /**
   * stop discovery, this is called by libp2p but if you are using
   * this standalone then this needs to be called
   */
  stop (cb) {
    this.node.unhandle(PROTO)
    this.node.removeListener('peer:connect', this._onConnection)
    cb()
  }

  peerDiscovery (targetNumberOfPeers) {
    const newPeers = this.node.peerBook.getAllArray()
    this._peerDiscovery(this.node, targetNumberOfPeers, newPeers)
    this.node.on('peer:connect', this._onConnection)
  }

  _onConnection (peer) {
    log('connected peer, restarting discovery', peer.id.toB58String())
    try {
      const info = this.node.peerBook.get(peer)
      if (!info._askedForPeers) {
        throw new Error()
      }
    } catch (e) {
      this._peerDiscovery(this.node, this.targetNumberOfPeers, [peer])
    }
  }

  _peerDiscovery (node, targetNumberOfPeers, newPeers) {
    if (!node.isStarted()) {
      setTimeout(() => { this._peerDiscovery(...arguments) }, 100)
      return
    }

    let knownPeers = node.peerBook.getAllArray()
    if (knownPeers.length < targetNumberOfPeers && newPeers.length !== 0) {
      newPeers.forEach(peer => {
        peer._askedForPeers = true
        node.dialProtocol(peer, PROTO, async (err, conn) => {
          if (!node.isStarted()) {
            if (err) {
              log('not yet started, removed peer', peer.id.toB58String(), err)
              node.peerBook.remove(peer)
            }
            return
          }
          if (err) {
            // Remove peers that we cannot connect to
            node.hangUp(peer, () => {
              node.peerBook.remove(peer)
              log('removed unreachable peer', peer.id.toB58String(), err)
            })
          } else {
            try {
              const peers = await readPeers(node, conn)
              const newPeers = await this.filterPeers(node, peers)
              return this._peerDiscovery(node, targetNumberOfPeers, newPeers)
            } catch (e) {
              // Remove peers that are potentially malicous
              node.hangUp(peer, () => {
                node.peerBook.remove(peer)
                log('removed malicious peer', peer.id.toB58String(), err)
                node.emit('error', peer)
              })
            }
          }
        })
      })
    }
  }

  filterPeers (node, peers) {
    const ids = Object.keys(peers)
    const newPeers = []
    ids.forEach(async id => {
      try {
        node.peerBook.get(id)
        log('already have peer ', id)
      } catch (e) {
        PeerId.createFromJSON(peers[id], (err, peerId) => {
          const peerInfo = new PeerInfo(peerId)
          const addresses = peers[id].multiaddrs
          addresses.forEach(ad => {
            peerInfo.multiaddrs.add(ad)
          })
          node.peerBook.put(peerInfo)
          newPeers.push(peerInfo)
          node.emit('peer:discovery', peerInfo)
        })
      }
    })
    return newPeers
  }
}

async function readPeers (node, conn) {
  const reader = Reader()
  pull(conn, reader)

  const lenData = await leb.unsigned.readBn(reader)

  return new Promise((resolve, reject) => {
    if (lenData.isZero()) {
      reader.abort()
      return resolve({})
    }

    reader.read(lenData.toNumber(), (err, data) => {
      if (err) {
        return reject(err)
      }

      data = data.toString()
      const peers = JSON.parse(data)
      reader.abort()
      resolve(peers)
    })
  })
}

function peerBookToJson (peerBook) {
  let peers = {}
  peerBook.getAllArray().forEach(pi => {
    const json = pi.id.toJSON()
    json.multiaddrs = pi.multiaddrs.toArray()
      .filter(a => !/127\.0\.0\.1|circuit/.test(a))
      .map(a => a.toString().split('/').slice(0, -2).join('/'))
    peers[pi.id.toB58String()] = json
  })
  return peers
}
