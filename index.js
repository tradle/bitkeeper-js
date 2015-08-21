'use strict'

var fs = require('fs')
var safe = require('safecb')
var Q = require('q')
var mkdirp = require('mkdirp')
var debug = require('debug')('bitkeeper-js')
var utils = require('tradle-utils')
var requireParam = utils.requireParam
var path = require('path')
var FSStorage = require('./lib/fsStorage')
var WebTorrent = require('webtorrent')
var reemit = require('re-emitter')
var common = require('./lib/common')
var EventEmitter = require('events').EventEmitter
var inherits = require('util').inherits
var toElistener = require('elistener')
var Jobs = require('simple-jobs')
var Timeouts = require('timeouts')
// var ports = require('promise-ports')
var DHT = require('bittorrent-dht/client')
var noop = function () {}

function Keeper (config) {
  EventEmitter.call(this)
  this._jobs = new Jobs()

  utils.bindPrototypeFunctions(this)

  this._config = config || {}
  this._initializers = []
  // this._pending = {}; // torrents that we're interested in but may not have files (or metadata) for yet
  this._seeding = {}
  this._timeouts = Timeouts()

  if (this.config('storage') === false) {
    this._storage = inMemoryStorage()
    this._loadDHT()
      .done()
  } else {
    this._initFromStorage()
      .then(this._checkReady)
      .done()
  }

  this.on('error', this._onerror)
}

Keeper.DHT = DHT
inherits(Keeper, EventEmitter)
toElistener(Keeper.prototype)

Keeper.prototype._onerror = function (err, torrent) {
  this._debug(err, torrent && torrent.infoHash)
  if (torrent) {
    var infoHash = torrent.infoHash
    if (!infoHash) {
      // we may have tried to load a torrent with an invalid infoHash
      this._client.torrents.some(function (t) {
        if (t === torrent) {
          infoHash = t.infoHash
          return true
        }
      })
    }

    if (infoHash) {
      this.emit('error:' + torrent.infoHash, err)
      this.removeTorrent(infoHash)
    }
  }
}

Keeper.prototype._debug = function () {
  var args = [].slice.call(arguments)
  args[0] = '[' + this.torrentPort() + '] ' + args[0]
  return debug.apply(null, args)
}

Keeper.prototype.report = function () {
  var self = this
  var torrents = this._client.torrents
  if (!torrents || !torrents.length) return

  this._debug('REPLICATION REPORT')

  torrents.forEach(function (torrent) {
    self._debug('  ' + torrent.infoHash + ' : ' + self.peersCount(torrent))
  })

  this._debug('END REPLICATION REPORT')
}

Keeper.prototype._checkReady = function () {
  var self = this
  if (this._ready) return
  if (!this._dht || !this._dht.ready) return
  // if (!this._portMapping) return
  if (!this._client || !this._client.ready) return
  if (!this._storage) return

  if (this._storage &&
      this.config('seedStored') !== false &&
      !this.config('private')) {
    return this.seedStored()
      .done(setReady)
  } else {
    setReady()
  }

  function setReady () {
    self._ready = true
    self._debug('ready')
    self.emit('ready')
  }
}

Keeper.prototype._watchDHT = function () {
  this._dhtPort = this._dht.address().port

  this.listenTo(this._dht, 'announce', this._onAnnounce)
  this.listenTo(this._dht, 'node', this._onNode)

  this.on('fullyReplicated', this.onFullyReplicated)
  this.monitorReplication()
  this.keepAlive()
}

Keeper.prototype._onAnnounce = function (addr, hash) {
  if (!this._ready) {
    return this.on('ready', this._onAnnounce.bind(this, addr, hash))
  }

  this.addPeer(addr, hash)
  this.emit('announce:' + hash, addr)
}

Keeper.prototype._onNode = function (addr) {
  this._dht._sendPing(addr, noop)
}

Keeper.prototype._initTorrentClient = function () {
  if (this._destroyed) return

  this._client = new WebTorrent({
    dht: this._dht,
    tracker: false,
    dhtPort: this.dhtPort(),
    torrentPort: this.torrentPort()
  })

  this._client.on('ready', this._checkReady)
  this._client.on('torrent', this._ontorrent)
  reemit(this._client, this, ['warn', 'error'])

  var peers = this._dht.peers
  if (peers) {
    for (var infoHash in peers) {
      var addrs = peers[infoHash].index
      for (var addr in addrs) {
        if (addrs[addr]) this.addPeer(addr, infoHash)
      }
    }
  }

  this._checkReady()
}

Keeper.prototype.keepAlive = function () {
  if (this._jobs.has('keepAlive')) return

  this._jobs.add('_pingNodes', this._pingNodes, 60000)
}

Keeper.prototype._pingNodes = function () {
  this._dht.nodes.toArray().forEach(function (n) {
    this._sendPing(n.addr, noop)
  }, this._dht)
}

Keeper.prototype.monitorReplication = function () {
  if (this._jobs.has('checkReplication')) return

  this._jobs.add('checkReplication', this.checkReplication, this.config('checkReplication') || 60000)
// this._jobs.add('report', this.report, 60000)
}

Keeper.prototype.checkTorrentReplication = function (torrent) {
  requireParam('torrent', torrent)

  var self = this

  this.judge(torrent)
    .then(function (verdict) {
      if (verdict.replicate) {
        self.replicate(torrent)
      } else if (verdict.drop) {
        return self.delayDrop(torrent)
      }
    // else {
    //   // recheck soon and drop
    //   setTimeout(function() {
    //     self.checkTorrentReplication(torrent, true)
    //   }, Math.random() * 60000)
    // }
    })
}

Keeper.prototype.delayDrop = function (torrent, delay) {
  var self = this

  delay = typeof delay === 'number' ?
    delay :
    Math.random() * 30000

  this._timeouts.timeout(function () {
    self.judge(torrent)
      .then(function (verdict) {
        if (verdict.drop) self.removeTorrent(torrent)
      })
  }, delay)
}

/**
 *  Override this to choose a different strategy for replicate/drop decisions
 */
Keeper.prototype.judge = function (torrent) {
  // for now, replicate all
  return Q.resolve({
    drop: false,
    replicate: true
  })

// var percentRepl = this.percentReplication(torrent)
// return Q.resolve({
//   replicate: percentRepl < 110,
//   drop: percentRepl > 125
// })
}

Keeper.prototype.checkReplication = function () {
  if (this._destroyed) return

  var torrents = this._client.torrents
  if (torrents) {
    torrents.forEach(this.checkTorrentReplication, this)
  }
}

Keeper.prototype._ontorrent = function (torrent) {
  var self = this

  if (this._destroyed) return

  // TODO: cleanup when torrents are removed/destroyed/etc.
  torrent.files.forEach(function (file) {
    file.select()
  })

  torrent.once('done', function () {
    self._seeding[torrent.infoHash] = true
    self.emit('done:' + torrent.infoHash, torrent)
    self.put(getFileData(torrent))
  })

  this.emit('torrent:' + torrent.infoHash, torrent)
}

Keeper.prototype.onFullyReplicated = function (infoHash) {
  this._debug(infoHash + ' has achieved its desired level of replication: ' + this.desiredReplication(infoHash))
  this.emit('fullyReplicated:' + infoHash)
}

Keeper.prototype.addPeer = function (addr, torrent) {
  var self = this

  if (typeof torrent === 'string') {
    var infoHash = torrent
    torrent = this.torrent(infoHash)
    if (!torrent) {
      return this.download(infoHash, function (err, torrent) {
        if (err) throw err

        self.addPeer(addr, torrent)
      })
    }
  }

  this._debug('Adding peer: ' + addr + ' for ' + torrent.infoHash)

  this.checkTorrentReplication(torrent)
}

/**
 * removes oneself as a peer for {torrent}
 * @param {string|Torrent} torrent
 */
Keeper.prototype.removeTorrent = function (torrent, cb) {
  cb = safe(cb)
  requireParam('torrent', torrent)

  if (!this._client) throw new Error('not ready')

  var infoHash = this.infoHash(torrent)
  torrent = this.torrent(infoHash)

  if (torrent) {
    this._debug('Removing torrent: ' + torrent.infoHash)
    this._client.remove(torrent, function () {
      torrent.removeAllListeners()
      if (cb) cb()
    })
  } else {
    cb()
  }
}

Keeper.prototype.download = function (infoHash, cb) {
  var self = this
  var cached = this.torrent(infoHash)
  cb = cb || noop

  if (cached) return cb(null, cached)

  this._client.add(infoHash)
  this.once('torrent:' + infoHash, function (torrent) {
    if (cb) cb(null, torrent)
    else self._debug('Got torrent: ' + torrent.infoHash)
  })
}

Keeper.prototype._initFromStorage = function () {
  var self = this

  var dir = path.resolve(this.config('storage') || 'storage')
  this.config('storage', dir)

  var txDir = path.join(dir, 'txs')
  this._dhtPath = path.join(dir, 'dht.json')

  return Q.nfcall(mkdirp, txDir)
    .then(function () {
      self._loadDHT()
      self._storage = new FSStorage(txDir)
    })
}

Keeper.prototype.seedStored = function () {
  var self = this
  if (!this._storage || !this._client) {
    throw new Error('not ready')
  }

  return this._storage.getAll()
    .then(function (vals) {
      return Q.allSettled(vals.map(self.seed))
    })
}

Keeper.prototype._loadDHT = function () {
  var self = this
  var dhtPromise

  if (this.config('dht')) {
    this._dontKillDHT = true
    dhtPromise = Q.resolve(this.config('dht'))
  } else {
    dhtPromise = getDHT({
      filePath: this._dhtPath,
      bootstrap: this.config('bootstrap')
    })
  }

  return dhtPromise.then(function (dht) {
    if (self._destroyed) return dht.destroy()

    self._dht = dht
    var sock = self._dht.socket
    if (sock.filterMessages) {
      sock.filterMessages(function (msg, rinfo) {
        return /^d1:.?d2:id20:/.test(msg)
      })
    }

    self.onDHTReady(self._watchDHT)
    self.onDHTReady(self._initTorrentClient)
    self.onDHTReady(self._checkReady)
    if (!self._dht.listening) self._dht.listen(self.dhtPort())

    if (self.config('storage') === false) return

    self.onDHTReady(self._persistDHT)
    ;['announce', 'node', 'removenode', 'removepeer'].forEach(function (event) {
      self.listenTo(self._dht, event, self._persistDHT)
    })
  })
}

Keeper.prototype.onDHTReady = function (cb) {
  var self = this

  process.nextTick(function () {
    if (!self._dht) return cb(new Error("keeper doesn't have DHT"))

    if (self._dht.ready) cb()
    else self.listenOnce(self._dht, 'ready', cb)
  })
}

/**
 * Self-destruct and cleanup
 **/
Keeper.prototype.destroy = function () {
  var self = this
  if (this._destroyed) return

  this._destroyed = true
  try {
    this.stopListening()
    this.removeAllListeners()
  } catch (err) {
  }

  this._jobs.clear()
  this._timeouts.clearAll()

  var tasks = []
  if (this._storage) {
    tasks.push(this._storage.close())
  }

  if (this._client) {
    // destroys DHT internally
    this._debug('destroying Webtorrent client')
    tasks.push(Q.ninvoke(this._client, 'destroy'))
  }

  if (!this._dontKillDHT) {
    this._debug('destroying DHT')
    tasks.push(Q.ninvoke(this._dht, 'destroy'))
  }

  return Q.all(tasks)
    .catch(function (err) {
      self._debug('failed to destroy', err)
    })
    .then(function () {
      self._debug('destroyed')
    })
}

/**
 * Persists the DHT to the local file system
 * @param {function} cb
 * @return {promise}
 **/
Keeper.prototype._persistDHT = function () {
  var self = this

  if (this._persistingDHT) return Q.resolve()

  this._persistingDHT = true
  var dhtStr = JSON.stringify(this._dht.toArray())

  return Q.ninvoke(utils, 'writeFile', {
    path: this._dhtPath,
    data: dhtStr
  })
    .catch(function (err) {
      self._debug('failed to store DHT', err)
    })
    .finally(function () {
      self._persistingDHT = false
    })
}

/**
 * Query peers to determine how many are storing a value for the given key.
 * @param {String} key
 * @param {Function} cb
 **/
// Keeper.prototype.calcReplicationCount = function(key, cb) {
//   cb(new Error('Not implemented'))
// }

Keeper.prototype.storage = function () {
  return this._storage
}

Keeper.prototype.config = function (configOption, value) {
  switch (arguments.length) {
    case 0:
      return this._config
    case 1:
      return this._config[configOption]
    case 2:
      this._config[configOption] = value
      break
  }
}

Keeper.prototype.hasTorrent = function (infoHash) {
  infoHash = this.infoHash(infoHash)
  return this.isSeeding(infoHash) || !!this._client.get(infoHash)
}

Keeper.prototype.isSeeding = function (infoHash) {
  return infoHash in this._seeding
}

/**
 *  @param {string|Buffer|Torrent} val
 */
Keeper.prototype.seed = function (val) {
  if (this.config('private')) return

  requireParam('val', val)

  var self = this
  var getTorrent
  var infoHash
  if (val.infoHash) {
    if (!(this.isSeeding(val.infoHash) || (val.storage && val.storage.done))) {
      throw new Error('you can only seed torrents whose contents have been downloaded')
    }

    getTorrent = Q(val)
  } else {
    if (typeof val === 'string') val = common.buffer(val)

    getTorrent = Q.ninvoke(utils, 'createTorrent', val)
  }

  return getTorrent
    .then(function (torrent) {
      if (self._destroyed) return

      infoHash = torrent.infoHash
      self._dht.announce(infoHash, self.torrentPort())
      self._dht.lookup(infoHash)
      if (self.isSeeding(infoHash)) return

      self._seeding[infoHash] = true
      if (self.hasTorrent(infoHash)) {
        return Q.ninvoke(self, 'removeTorrent', infoHash)
          .then(seed)
      } else {
        return seed()
      }
    })

  function seed () {
    self._debug('seeding: ' + infoHash)

    return Q.ninvoke(self._client, 'seed', val, {
      name: utils.getTorrentName(val)
    })
  }
}

Keeper.prototype.replicate = function (infoHash) {
  if (this.isSeeding(infoHash)) this.seed(this.torrent(infoHash))
  else this.download(infoHash)
}

Keeper.prototype.validate = function (key, val) {
  return Q.ninvoke(utils, 'getInfoHash', val)
    .then(function (infoHash) {
      if (key !== infoHash) throw utils.httpError(400, 'Key must be the infohash of the value, in this case: ' + infoHash)
    })
}

// /**
//  *  @return {Q.Promise} promise that resolves when the swarm for {key} reaches {count}
//  */
// Keeper.prototype.replicate = function (key, val, count) {
//   if (this.torrent(key)) {
//     // if (!this.isFullyReplicated(key)) {
//     //   // reannounce
//     //   this._dht.announce(key, this.torrentPort())
//     // }

//     return Q.resolve()
//   }

//   var replicatedEvent = 'fullyReplicated:' + key
//   var valBuf = common.buffer(val)
//   var deferred = Q.defer()

//   this.seed(valBuf)
//   this.once(replicatedEvent, deferred.resolve)

//   return deferred.promise
// }

/**
 *  @param {string|Torrent} infoHash
 *  @return the number of peers we currently know of for {infoHash}
 */
Keeper.prototype.peersCount = function (infoHash) {
  // var cached = this._client.get(key)
  // var numPeers = getNestedProperty(cached, 'swarm._peersLength')
  // return numPeers || 0
  requireParam('infoHash', infoHash)
  infoHash = this.infoHash(infoHash)

  var peers = this._dht.peers[infoHash]
  return peers ? peers.list.length : 0
}

Keeper.prototype.torrent = function (infoHash) {
  requireParam('infoHash', infoHash)

  if (typeof infoHash === 'string') return this._client.get(infoHash)

  return infoHash
}

Keeper.prototype.infoHash = function (torrent) {
  requireParam('torrent', torrent)

  if (typeof torrent === 'string') return torrent

  return torrent.infoHash
}

Keeper.prototype.desiredReplication = function (torrent) {
  requireParam('torrent', torrent)

  torrent = this.torrent(torrent)
  if (!torrent) throw new Error('torrent not found in memory')

  var repl = getNestedProperty(torrent, 'info.replication')
  return repl || 10
}

Keeper.prototype.percentReplication = function (torrent) {
  requireParam('torrent', torrent)

  torrent = this.torrent(torrent)
  var desiredRepl = this.desiredReplication(torrent)
  var numPeers = this.peersCount(torrent)

  return desiredRepl ? 100 * numPeers / desiredRepl : Infinity
}

Keeper.prototype.isFullyReplicated = function (torrent) {
  return this.percentReplication(torrent) >= 100
}

Keeper.prototype.get = Keeper.prototype.getMany = function (keys) {
  // var self = this
  if (!Array.isArray(keys)) keys = [keys]

  return Q.allSettled(keys.map(this.getOne))
    .then(function (results) {
      return results.map(function (r) {
        return r.value
      })
    })
}

Keeper.prototype.getOne = function (key) {
  var self = this

  return this.storage()
    .getOne(key)
    .then(function (val) {
      if (typeof val === 'undefined') throw new Error('not found')

      return val
    })
    .catch(function (err) {
      if (err) self._debug('Error on get', err)
      // timeout
      return self.promise(key, 10000)
    })
}

/**
 *  Promise to load a torrent with infoHash {key}
 *  @param {string} infoHash
 *  @return {Q.Promise} promise that resolves with torrent file contents (not torrent metadata, but actual data)
 */
Keeper.prototype.promise = function (infoHash, timeout) {
  var self = this
  var deferred = this._defer(timeout)

  this.on('put:' + infoHash, deferred.resolve)
  this.on('error:' + infoHash, deferred.reject)

  deferred.promise.finally(function () {
    self.removeListener('put:' + infoHash, deferred.resolve)
    self.removeListener('error:' + infoHash, deferred.reject)
  })

  this.download(infoHash)
  return deferred.promise
}

Keeper.prototype.isKeeper = function () {
  return true
}

Keeper.prototype.put = function (key, value) {
  var self = this

  if (typeof value !== 'undefined') {
    return this.validate(key, value).then(function () {
      return self._doPut(key, value)
    })
  } else {
    value = key
    requireParam('value', value)
    return Q.ninvoke(utils, 'getInfoHash', value).then(function (infoHash) {
      return self._doPut(infoHash, value)
    })
  }
}

Keeper.prototype._doPut = function (key, val) {
  var self = this

  return self.storage()
    .putOne(key, val)
    .catch(function (err) {
      if (/exists/.test(err.message)) {
        return false
      } else {
        throw err
      }
    })
    .then(function (put) {
      if (!put) return // all is good, but we already had this key/value

      self._debug('put ' + key)
      self.emit('put', key, val)
      self.emit('put:' + key, val)
      if (!self.isSeeding(key)) self.seed(val)

      return {
        key: key,
        val: val
      }
    // self._dht.announce(key, self.torrentPort())
    })
}

Keeper.prototype.publicAddress = function (ip) {
  return this._dht.publicAddress.apply(this._dht, ip)
}

Keeper.prototype.clear = function () {
  return this.storage().clear()
}

Keeper.prototype.exitIfErr = function (err) {
  if (err) {
    this._debug(err)
    process.exit()
  }
}

Keeper.prototype.dhtPort = function () {
  return this._dhtPort || this.config('dhtPort')
}

Keeper.prototype.torrentPort = function () {
  return this.config('torrentPort') || this.dhtPort()
}

// Keeper.prototype.mapPorts = function () {
//   var dhtPort = this.dhtPort()
//   var torrentPort = this.torrentPort()

//   // TODO: check if simultaneous mapping is ok
//   return ports.mapPorts({
//     public: dhtPort,
//     private: dhtPort,
//     hijack: true
//   }, {
//     public: torrentPort,
//     private: torrentPort,
//     hijack: true
//   })

// }

Keeper.prototype._defer = function (timeout) {
  var self = this
  var deferred = Q.defer()
  if (typeof timeout === 'undefined') return deferred

  var timeoutId = this._timeouts.timeout(function () {
    deferred.reject(new Error('timeout'))
  }, timeout)

  deferred.promise.finally(function () {
    self._timeouts.clear(timeoutId)
  })

  return deferred
}

function inMemoryStorage () {
  var map = {}
  return {
    putOne: function (key, val) {
      var numPut = 0
      if (!(key in map)) {
        map[key] = val
        numPut++
      }

      return Q.resolve(numPut)
    },
    getOne: function (key) {
      return (key in map) ? Q.resolve(map[key]) : Q.resolve()
    },
    getMany: function (keys) {
      return Q.resolve(keys.map(function (key) {
        return map[key]
      }))
    },
    getAll: function () {
      return Q.resolve(values(map))
    },
    close: function () {
      return Q.resolve()
    }
  }
}

function getFileData (torrent) {
  var pieces = torrent.files[0].pieces

  return Buffer.concat(pieces.map(
    function (piece) {
      return piece.buffer
    }
  ))
}

function getNestedProperty (obj, path) {
  if (!obj) return

  var dotIdx = path.indexOf('.')
  if (dotIdx === -1) return obj[path]

  return getNestedProperty(obj[path.slice(0, dotIdx)], path.slice(dotIdx + 1))
}

function values (obj) {
  var vals = []
  for (var p in obj) {
    if (obj.hasOwnProperty(p)) vals.push(obj[p])
  }

  return vals
}

function getDHT (options) {
  var bootstrap = options.bootstrap
  if (!options.filePath) {
    var dht = bootstrap ? new Keeper.DHT({ bootstrap: bootstrap }) : new Keeper.DHT()
    return Q.resolve(dht)
  }

  var filePath = path.resolve(options.filePath)
  return Q.ninvoke(fs, 'readFile', filePath)
    .then(function (buf) {
      var nodes = JSON.parse(buf.toString())
      if (!nodes.length) return getDHT()

      if (bootstrap) nodes.push.apply(nodes, bootstrap)
      return new Keeper.DHT({
        bootstrap: nodes
      })
    })
    .catch(function (err) {
      if (err) debug('unable to read dht from file')

      return getDHT({
        bootstrap: options.bootstrap
      })
    })
}

module.exports = Keeper
