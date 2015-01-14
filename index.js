
'use strict';

var assert = require('assert');
var Q = require('q');
var fs = require('fs');
var mkdirp = require('mkdirp');
var debug = require('debug')('bitkeeper-js');
var utils = require('tradle-utils');
var writeFile = Q.denodeify(fs.writeFile);
var path = require('path');
var FSStorage = require('./lib/fsStorage');
var WebTorrent = require('webtorrent');
var DHT = require('bittorrent-dht');
var reemit = require('re-emitter');
var common = require('./lib/common');
var EventEmitter = require('events').EventEmitter;
var inherits = require('util').inherits;
var Jobs = require('simple-jobs');
var ports = require('promise-ports');

function Keeper(config) {
  var self = this;

  EventEmitter.call(this);
  this._jobs = new Jobs();

  common.bindPrototypeFunctions(this);

  this._config = config || {};
  this._initializers = [];
  this._pending = {}; // torrents that we're interested in but may not have files (or metadata) for yet

  var pub = this.torrentPort();
  var priv = pub;

  ports.mapPort(pub, priv, true)
    .then(function() {
      console.log('Torrent port open: ' + pub);
      self._portMapping = { 'public': pub, 'private': priv };
      self.checkReady();
    })
    .catch(this.exitIfErr);

  // if (this.config('dht')) this._dht = this.config('dht');

  if (this.config('storage') === false) {
    this._dht = this.config('dht') || new DHT();
    this._storage = inMemoryStorage();
  }
  else
    this._initFromStorage();

  this.on('error', this._onerror);
}

inherits(Keeper, EventEmitter);

Keeper.prototype._onerror = function(err, torrent) {
  this._debug(err, torrent && torrent.infoHash);
  if (torrent) {
    var infoHash = torrent.infoHash;
    if (!infoHash) {
      // we may have tried to load a torrent with an invalid infoHash
      for (var p in this._pending) {
        if (this._pending[p] === torrent) {
          infoHash = p;
          break;
        }
      }
    }

    if (infoHash) {
      delete this._pending[torrent.infoHash];
      this.emit('error:' + torrent.infoHash, err);
    }
  }
}

Keeper.prototype._debug = function() {
  var args = [].slice.call(arguments);
  args[0] = '[' + this.torrentPort() + '] ' + args[0];
  return debug.apply(null, args);
}

Keeper.prototype.report = function() {
  var self = this;
  var torrents = this._client.torrents;
  if (!torrents || !torrents.length) return;

  this._debug('REPLICATION REPORT');

  torrents.forEach(function(torrent) {
    self._debug('  ' + torrent.infoHash + ' : ' + self.peersCount(torrent));
  });

  this._debug('END REPLICATION REPORT');
}

Keeper.prototype.checkReady = function() {
  if (this._ready) return;
  if (!this._dht || !this._dht.ready) return;
  if (!this._portMapping) return;
  if (!this._client || !this._client.ready) return;

  this._ready = true;
  this._debug('ready');
  this.emit('ready');
}

Keeper.prototype._watchDHT = function() {
  var self = this;

  this._dht.on('peer', function(addr, hash, from) {
    self.addPeer(addr, hash);
    self.emit('peer:' + hash, addr);
  });

  this._dht.on('announce', function(addr, hash) {
    self.addPeer(addr, hash);
    self.emit('announce:' + hash, addr);
  });

  this.on('fullyReplicated', this.onFullyReplicated);
  this.monitorReplication();
}

Keeper.prototype._initTorrentClient = function() {
  this._client = new WebTorrent({
    dht: this._dht,
    tracker: false,
    dhtPort: this._dht.port,
    torrentPort: this.torrentPort()
  });

  this._client.on('ready', this.checkReady);
  this._client.on('torrent', this._ontorrent);
  reemit(this._client, this, ['warn', 'error']);

  this.checkReady();
}

Keeper.prototype.monitorReplication = function() {
  if (this._monitoringReplication) return;

  this._monitoringReplication = true;

  this._jobs.add('checkReplication', this.checkReplication, 60000);
  this._jobs.add('report', this.report, 60000);
}

Keeper.prototype.checkTorrentReplication = function(torrent) {
  requireParam('torrent', torrent);

  var self = this;

  this.judge(torrent)
  .then(function(verdict) {
    if (verdict.replicate) {
      self._dht.announce(torrent.infoHash);
      self.seed(torrent);
    }
    else if (verdict.drop) return self.delayDrop(torrent);
    // else {
    //   // recheck soon and drop
    //   setTimeout(function() {
    //     self.checkTorrentReplication(torrent, true);
    //   }, Math.random() * 60000);
    // }
  })
}

Keeper.prototype.delayDrop = function(torrent, delay) {
  var self = this;

  delay = typeof delay === 'number' ? 
    delay : 
    Math.random() * 30000;

  setTimeout(function() {
    self.judge(torrent)
    .then(function(verdict) {
      if (verdict.drop) self.removeTorrent(torrent);
    })
  }, delay);
}

/**
 *  Override this to choose a different strategy for replicate/drop decisions
 */
Keeper.prototype.judge = function(torrent) {
  var percentRepl = this.percentReplication(torrent);
  return Q.resolve({
    replicate: percentRepl < 110,
    drop: percentRepl > 125
  });
}

Keeper.prototype.checkReplication = function() {
  var self = this;

  var torrents = this._client.torrents;
  if (torrents) torrents.forEach(function(torrent) {
    self.checkTorrentReplication(torrent);
  });
}

Keeper.prototype._ontorrent = function(torrent) {
  var self = this;

  if (this._destroyed) return;

  // TODO: cleanup when torrents are removed/destroyed/etc.
  torrent.files.forEach(function(file) {
    file.select();
  });

  torrent.once('done', function() {
    self.emit('done:' + torrent.infoHash, torrent);
    self.put(getFileData(torrent));
  });

  delete this._pending[torrent.infoHash];
  this.emit('torrent:' + torrent.infoHash, torrent);
}

Keeper.prototype.onFullyReplicated = function(infoHash) {
  this._debug(infoHash + ' has achieved its desired level of replication: ' + this.desiredReplication(infoHash));
  this.emit('fullyReplicated:' + infoHash);
}

Keeper.prototype.addPeer = function(addr, torrent) {
  var self = this;

  if (typeof torrent === 'string') {
    var infoHash = torrent;
    torrent = this.torrent(infoHash);
    if (!torrent) {
      return this.getTorrent(infoHash, function(err, torrent) {
        if (err) throw err;

        self.addPeer(addr, torrent);
      });
    }
  }

  this._debug('Adding peer: ' + addr + ' for ' + torrent.infoHash);

  this.checkTorrentReplication(torrent);
}

/**
 * removes oneself as a peer for {torrent}
 * @param {string|Torrent} torrent
 */
Keeper.prototype.removeTorrent = function(torrent) {
  requireParam('torrent', torrent);

  var infoHash = this.infoHash(torrent);
  torrent = this.torrent(infoHash);

  if (torrent) {
    this._debug('Removing torrent: ' + torrent.infoHash);
    this._client.remove(infoHash);
  }
}

Keeper.prototype.getTorrent = function(infoHash, cb) {
  // var self = this;

  var cached = this._client.get(infoHash);
  if (cached) return cb(null, cached);

  if (!this.isPending(infoHash)) {
    var torrent = this._client.download(infoHash);
    this.markPending(infoHash, torrent);
  }

  this.once('torrent:' + infoHash, function(torrent) {
    cb(null, torrent);
  });
}

Keeper.prototype._initFromStorage = function() {
  var self = this;
  var dir = this.config('storage') || 'storage';

  this.config('storage', dir);

  var absDir = path.join(__dirname, dir);
  this._dhtPath = path.join(absDir, 'DHT', 'dht.json');

  Q.nfcall(mkdirp, absDir)
  .done(function() {
    self._loadDHT();
    self._storage = new FSStorage(absDir);
    self.on('ready', seedStored);
  });

  function seedStored() {
    self._storage.getAll().then(function(docs) {
      docs.forEach(function(doc) {
        self.seed(doc.value);
      });
    });
  }
}

Keeper.prototype._loadDHT = function() {
  var self = this;

  if (this._dht) return;

  var getDHT;
  if (this.config('dht'))
    getDHT = Q.resolve(this.config('dht'));
  else
    getDHT = common.dht(this._dhtPath);

  getDHT.then(function(dht) {
    self._dht = dht;
    self.onDHTReady(self._watchDHT);
    self.onDHTReady(self._persistDHT);
    self.onDHTReady(self._initTorrentClient);
    if (!self._dht.listening) self._dht.listen();

    ['announce', 'node', 'removenode', 'removepeer'].forEach(function(event) {
      self._dht.on(event, self._persistDHT);
    });
  });
}

Keeper.prototype.onDHTReady = function(cb) {
  var self = this;

  process.nextTick(function() {
    if (!self._dht) return cb(new Error('keeper doesn\'t have DHT'));

    if (self._dht.ready)
      cb();
    else 
      self._dht.on('ready', cb)
  });
}

/**
 * Self-destruct and cleanup
**/
Keeper.prototype.destroy = function() {
  var self = this;

  if (this._destroyed) return

  this._destroyed = true;
  this.removeAllListeners();
  this._jobs.clear();

  return Q.all([
    Q.ninvoke(this._client, 'destroy'), // destroys DHT internally
    // Q.ninvoke(this.server, 'close'),
    this._storage.close()
  ]).then(function() {
    self._client.removeAllListeners();
    self._dht.removeAllListeners();
  });
}

/**
 * Persists the DHT to the local file system
 * @param {function} cb
 * @return {promise}
**/
Keeper.prototype._persistDHT = function() {
  var self = this;

  if (this._persistingDHT) return Q.resolve();

  this._persistingDHT = true;
  var dhtStr = JSON.stringify(this._dht.toArray());

  return writeFile(this._dhtPath, dhtStr)
    .then(function() {
      self._persistingDHT = false;
    })
    .catch(function(err) {
      if (err) self._debug('failed to store DHT', err);
    })
}

/**
 * Query peers to determine how many are storing a value for the given key.
 * @param {String} key
 * @param {Function} cb
**/
// Keeper.prototype.calcReplicationCount = function(key, cb) {
//   cb(new Error('Not implemented'));
// }

Keeper.prototype.storage = function() {
  return this._storage;
}

Keeper.prototype.config = function(configOption, value) {
  if (arguments.length === 1) {
    return typeof configOption === 'undefined' ? 
        this._config : 
        this._config[configOption];
  }

  this._config[configOption] = value;
}

Keeper.prototype.hasTorrent = function(infoHash) {
  if (this._client.get(infoHash)) return true;
}

Keeper.prototype.isPending = function(infoHash) {
  return this._pending.hasOwnProperty(infoHash);
}

Keeper.prototype.markPending = function(infoHash, torrent) {
  this._pending[infoHash] = torrent || true;
}

/**
 *  @param {string|Buffer|Torrent} val
 */ 
Keeper.prototype.seed = function(val) {
  var self = this;

  requireParam('val', val);

  if (val.infoHash) { 
    // val is Torrent
    var infoHash = val.infoHash;
    if (this.hasTorrent(infoHash) || this.isPending(infoHash)) return; //this._client.get(val.infoHash)) return;

    this.markPending(infoHash);
    this._debug('1. Replicating torrent: ' + infoHash);
    return this._client.seed(val);
  }

  if (typeof val === 'string')
    val = common.buffer(val);

  return utils.getInfoHash(val, function(err, infoHash) {
    if (err) throw err;

    if (self.hasTorrent(infoHash) || self.isPending(infoHash)) return; //this._client.get(val.infoHash)) return;

    self.markPending(infoHash);
    return self._client.seed(val, { name: utils.getTorrentName(val) });
  });
}

Keeper.prototype.validate = function(key, val) {
  return Q.ninvoke(utils, 'getInfoHash', val)
    .then(function(infoHash) {
      if (key !== infoHash) throw common.httpError(400, 'Key must be the infohash of the value, in this case: ' + infoHash);
    });
}

/**
 *  @return {Q.Promise} promise that resolves when the swarm for {key} reaches {count}
 */
Keeper.prototype.replicate = function(key, val, count) {
  if (this.torrent(key)) {
    // if (!this.isFullyReplicated(key)) {
    //   // reannounce
    //   this._dht.announce(key, this.torrentPort());
    // }

    return Q.resolve();
  }

  var replicatedEvent = 'fullyReplicated:' + key;
  var valBuf = common.buffer(val);
  var deferred = Q.defer();

  this.seed(valBuf);
  this.once(replicatedEvent, deferred.resolve);

  return deferred.promise;
}

/**
 *  @param {string|Torrent} infoHash
 *  @return the number of peers we currently know of for {infoHash}
 */
Keeper.prototype.peersCount = function(infoHash) {
  // var cached = this._client.get(key);
  // var numPeers = getNestedProperty(cached, 'swarm._peersLength');  
  // return numPeers || 0;
  requireParam('infoHash', infoHash);
  infoHash = this.infoHash(infoHash); // normalize

  var peers = this._dht.peers[infoHash];
  return peers ? peers.list.length : 0;
}

Keeper.prototype.torrent = function(infoHash) {
  requireParam('infoHash', infoHash);

  if (typeof infoHash === 'string') return this._client.get(infoHash);

  return infoHash;
}

Keeper.prototype.infoHash = function(torrent) {
  requireParam('torrent', torrent);

  if (typeof torrent === 'string') return torrent;

  return torrent.infoHash;
}

Keeper.prototype.desiredReplication = function(torrent) {
  requireParam('torrent', torrent);
  
  torrent = this.torrent(torrent); // normalize
  if (!torrent) throw new Error('torrent not found in memory');

  var repl = getNestedProperty(torrent, 'info.replication');
  return repl || 10;
}

Keeper.prototype.percentReplication = function(torrent) {
  requireParam('torrent', torrent);
  
  torrent = this.torrent(torrent); // normalize
  var desiredRepl = this.desiredReplication(torrent);
  var numPeers = this.peersCount(torrent);

  return desiredRepl ? 100 * numPeers / desiredRepl : Infinity;
}

Keeper.prototype.isFullyReplicated = function(torrent) {
  return this.percentReplication(torrent) >= 100;
}

Keeper.prototype.get = function(keys) {
  // var self = this;
  if (!Array.isArray(keys))
    keys = [keys];

  return Q.allSettled(keys.map(this.getOne))
    .then(function(results) {
      return results.map(function(r) {
        return r.value;
      })
    });
}

Keeper.prototype.getOne = function(key) {
  var self = this;
  return this.storage()
    .getOne(key)
    .then(function(val) {
      if (typeof val !== 'undefined') return val;

      return self.promise(key, 5000); // timeout
    });
}


/**
 *  Promise to load a torrent with infoHash {key}
 *  @param {string} infoHash
 *  @return {Q.Promise} promise that resolves with torrent file contents (not torrent metadata, but actual data)
 */ 
Keeper.prototype.promise = function(infoHash, timeout) {
  var self = this;
  var deferred = defer(timeout);

  this.on('put:' + infoHash, deferred.resolve);
  this.on('error:' + infoHash, deferred.reject);

  deferred.promise.finally(function() {
    self.removeListener('put:' + infoHash, deferred.resolve);
    self.removeListener('error:' + infoHash, deferred.reject);
  });

  this.getTorrent(infoHash);
  return deferred.promise;
}

Keeper.prototype.put = function(key, value) {
  var self = this;

  if (typeof value !== 'undefined') 
    return this.validate(key, value).then(function() {
      return self._doPut(key, value);
    });
  else {
    value = key;
    requireParam('value', value);
    return Q.ninvoke(utils, 'getInfoHash', value).then(function(infoHash) {
      return self._doPut(infoHash, value);
    });
  }
}

Keeper.prototype._doPut = function(key, val) {
  var self = this;

  return self.storage()
    .putOne(key, val, { overwrite: true })
    .then(function(numPut) {
      if (numPut) {
        self.emit('put', key, val);
        self.emit('put:' + key, val);
        self.seed(val);
      }
      // self._dht.announce(key, self.torrentPort());
    });
}

Keeper.prototype.externalIp = function(ip) {
  if (ip) this._externalIp = ip;

  return this._externalIp;
}

Keeper.prototype.clear = function() {
  return this.storage().clear();
}

Keeper.prototype.torrentPort = function() {
  return this.config('address').torrentPort;
}

Keeper.prototype.exitIfErr = function(err) {
  if (err) {
    this._debug(err);
    process.exit();
  }
}

// Keeper.prototype.dhtPort = function() {
//   return this.config('address').dhtPort;
// }

function isFinished(promise) {
  var state = promise.inspect().state;
  return state !== 'unknown' && state !== 'pending';
}

function inMemoryStorage() {
  var map = {};
  return {
    putOne: function(key, val) {
      map[key] = val;
      return Q.resolve();
    },
    getOne: function(key) {
      return (key in map) ? Q.resolve(map[key]) : Q.resolve();
    },
    getMany: function(keys) {
      return Q.resolve(keys.map(function(key) { 
        return map[key];
      }));
    },
    close: function() {
      return Q.resolve();
    }
  }
}

function getFileData(torrent) {
  var pieces = torrent.files[0].pieces;

  return Buffer.concat(pieces.map(
    function(piece) { 
      return piece.buffer 
    }
  ));
}

function getNestedProperty(obj, path) {
  if (!obj) return;

  var dotIdx = path.indexOf('.');
  if (dotIdx === -1) return obj[path];

  return getNestedProperty(obj[path.slice(0, dotIdx)], path.slice(dotIdx + 1));
}

function requireParam(name, value) {
  assert(typeof value !== 'undefined', 'Missing required parameter: ' + name);
  return value;
}

function defer(timeout) {
  var deferred = Q.defer();
  if (typeof timeout === 'undefined') return deferred;

  var timeoutId = setTimeout(function() {
    deferred.reject(new Error('timeout'));
  }, timeout);

  deferred.promise.finally(function() {
    clearTimeout(timeoutId);
  });

  return deferred;
}

module.exports = Keeper;