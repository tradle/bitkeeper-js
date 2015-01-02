
'use strict';

var assert = require('assert');
var Q = require('q');
var fs = require('fs');
var once = require('once');
var debug = require('debug')('node-bitkeeper');
var utils = require('tradle-utils');
// var request = require('request');
// var querystring = require('querystring');
// var readFile = Q.denodeify(fs.readFile);
var writeFile = Q.denodeify(fs.writeFile);
var path = require('path');
// var debounce = require('debounce');
var Storage = require('./lib/storage');
var WebTorrent = require('webtorrent');
var DHT = require('bittorrent-dht');
var reemit = require('re-emitter');
// var createTorrent = require('create-torrent');
// var parseTorrent = require('parse-torrent');
var common = require('./lib/common');
// var log = console.log.bind(console);
var EventEmitter = require('events').EventEmitter;
var inherits = require('util').inherits;
var server = require('./lib/server');
var ports = require('./lib/ports');
var INSTANCE_IDX = 0;
// var KeeperAPI = require('bitkeeperAPI');
// var DEFAULT_FILE_OPTIONS = {
//   encoding: 'utf8'
// };

// // hack Webtorrent to track downloads

// var origDownload = Webtorrent.prototype.download;

// Webtorrent.prototype.download = 
// Webtorrent.prototype.add = function(torrentId) {
//   if (!this._downloading) this._downloading = {};

//   var infoHash = torrentId.infoHash || torrentId;
//   var deferred = Q.defer();
//   return this._downloading[infoHash] = deferred.promise;
// }

function Keeper(config) {
  var self = this;

  this._id = INSTANCE_IDX++;

  EventEmitter.call(this);

  common.bindPrototypeFunctions(this);

  this._config = config || {};
  this._initializers = [];
  this._pending = {}; // torrents that we're interested in but may not have files (or metadata) for yet

  var pub = this.torrentPort();
  var priv = pub;

  ports.mapPort(pub, priv).then(function() {
    self._portMapping = { 'public': pub, 'private': priv };
    self.checkReady();
  }).catch(function(err) {
    self._debug('Failed to create port mapping', err);
    throw err;
  });

  this._server = server.create(this, this.port(), function() {
    self._serverReady = true;
    self.checkReady();
  });

  if (this._config.storage === false) {
    this._dht = this._config.dht || new DHT();
    this._storage = inMemoryStorage();
  }
  else
    this._initFromStorage();

  this.onDHTReady(once(this._onDHTReady));
}

inherits(Keeper, EventEmitter);

Keeper.prototype._debug = function() {
  var args = [].slice.call(arguments);
  args[0] = '[' + this.port() + '] ' + args[0];
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
  if (!this._client.ready) return;
  if (!this._serverReady) return;

  this._ready = true;
  this._debug('ready');
  this.emit('ready');
}

Keeper.prototype._onDHTReady = function() {
  var self = this;

  this._dht.on('peer', function(addr, hash, from) {
    self.addPeer(addr, hash);
    self.emit('peer:' + hash, addr);
  });

  this._dht.on('announce', function(addr, hash) {
    self.addPeer(addr, hash);
    self.emit('announce:' + hash, addr);
  });

  this._client = new WebTorrent({
    dht: this._dht,
    tracker: false,
    dhtPort: this._dht.port,
    torrentPort: this.torrentPort()
  });

  this._client._tradleId = this._id;
  this._client.on('ready', this.checkReady);
  this._client.on('torrent', this._ontorrent);
  reemit(this._client, this, ['warn', 'error']);

  this.on('fullyReplicated', this.onFullyReplicated);
  this.monitorReplication();

  this.checkReady();
}

Keeper.prototype.monitorReplication = function() {
  if (this._monitoringReplication) return;

  this._monitoringReplication = true;

  setInterval(this.checkReplication, 60000);
  setInterval(this.report, 5000);
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
  if (cached) return Q.resolve(cached);

  if (this.isPending(infoHash)) {
    this.once('torrent:' + infoHash, function(torrent) {
      cb(null, torrent);
    });

    return;
  }

  // if (!this._downloading[infoHash]) {
  //   var deferred = Q.defer();
  //   this._downloading[infoHash] = deferred.promise;
  //   this._client.download(infoHash, function(torrent) {
  //     delete self._downloading[infoHash];
  //     deferred.resolve(torrent);
  //   });
  // }

  this.markPending(infoHash);
  this._client.download(infoHash);

  // return this._downloading[infoHash];
}

Keeper.prototype._initFromStorage = function() {
  var self = this;

  this._config.storage = this._config.storage || 'storage';
  this._storage = new Storage(path.join(__dirname, this._config.storageDir, 'main.db'));
  this._storage.getAll()
  .then(function(docs) {
    docs.forEach(function(doc) {
      self.seed(doc.val);
    });
  });

  this._dhtPath = path.join(__dirname, this._config.storageDir, 'dht.json');
  this._loadDHT();
}

Keeper.prototype._loadDHT = function() {
  var self = this;

  if (this._dht) return;

  if (this._config.dht) {
    this._dht = this._config.dht;
    return Q.resolve();
  }

  return common.dht(self._dhtPath)
  .then(function(dht) {
    self._dht = dht;
    self.onDHTReady(self._persistDHT);
    if (!self._dht.listening) self._dht.listen();

    ['announce', 'node', 'removenode', 'removepeer'].forEach(function(event) {
      self._dht.on(event, self._persistDHT);
    });
  });
}

Keeper.prototype.onDHTReady = function(cb) {
  var self = this;

  process.nextTick(function() {
    if (self._dht && self._dht.ready) 
      cb();
    else 
      self._dht.on('ready', cb)
  });
}

// /**
//  * Estimate the number of peers, including ourselves, that we know are storing the given key. For a better estimate, use calcReplicationCount
//  * @param {String} key
//  * @param {function} cb - async because we need to check our local db to know if we're replicating the key
// **/
// Keeper.prototype.replicationCount = function(key, cb) {
//   var count = 0;
//   var peers = this.dht.peers[key];
//   if (peers)
//     count += Object.keys(peers.index).filter(isTradleNode).length;

//   this._getFromStorage(key, function(err, val) {
//     cb(null, err ? count : count + 1);
//   });
// }

/**
 * Self-destruct and cleanup
**/
Keeper.prototype.destroy = function() {
  var self = this;

  if (this._destroyed) return

  this._destroyed = true;
  this.removeAllListeners();

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
    if (err) log.error('failed to store DHT', err);
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

Keeper.prototype.config = function(configOption) {
  return typeof configOption === 'undefined' ? 
      this._config : 
      this._config[configOption];
}

Keeper.prototype.hasTorrent = function(infoHash) {
  if (this._client.get(infoHash)) return true;
}

Keeper.prototype.isPending = function(infoHash) {
  return this._pending.hasOwnProperty(infoHash);
}

Keeper.prototype.markPending = function(infoHash) {
  this._pending[infoHash] = true;
}

/**
 *  @param {string|Buffer|Torrent} val
 */ 
Keeper.prototype.seed = function(val) {
  var self = this;

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

  // Q.ninvoke(utils, 'getInfoHash', val)
  //   .then(function(infoHash) {
  //     if (!self.hasTorrent(infoHash) && !self.isPending(infoHash)) {
  //       self._debug('2. Replicating torrent: ' + infoHash);
  //       self.markPending(infoHash); 
  //       self._client.seed(val, { name: utils.getTorrentName(val) });
  //     }
  //   });
}

Keeper.prototype.validate = function(key, val) {
  return Q.ninvoke(utils, 'getInfoHash', val)
    .then(function(infoHash) {
      assert.equal(key, infoHash, 'Key must be the infohash of the value');
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

  // return Q.Promise(function(resolve) {
  //   function checkCount() {
  //     log('acquired new peer for ' + key);

  //     if (self.peersCount(key) >= count) {
  //       log('achieved desired level of replication (' + count + ') for ' + key);
  //       self.removeListener(peerEvent, checkCount);
  //       resolve();
  //     }
  //   }

  //   self.on(peerEvent, checkCount);
  //   checkCount();
  // });
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

// Keeper.prototype._doReplicate = function(key, val, count) {
//   var self = this;  
//   var peers = this._dht.peers[key];
//   var closest = this._dht.nodes.closest({ id: key }, DHT.K);
//   if (peers && peers.length) closest = closest.filter(function(contact) {
//     return !peers[contact.addr];
//   });

//   if (typeof val !== 'string') val = val.toString();

//   if (closest.length < count) return this.getMoreNodes(key, closest).then(function() {
//     return self._doReplicate(key, val, count);
//   });

//   return this.askToStore(closest.slice(0, count), key, val)
//   .then(function(numStored) {
//     if (!numStored) throw new Error('no peers accepted put'); // TODO: implement something sane

//     count -= numStored;
//     if (count) return self._doReplicate(key, val, count);
//   });
// }

Keeper.prototype.getMoreNodes = function(infoHash, skipNodes) {
  return Q.reject(new Error('not implemented'));
}

// Keeper.prototype.askToStore = function(contacts, key, val) {
//   var self = this;

//   var tasks = contacts.map(function(contact) {
//     return self.askOneToStore(contact, key, val);
//   });

//   return Q.allSettled(tasks)
//   .then(function(results) {
//     return results.reduce(function(memo, result) {
//       if (result.state === 'fulfilled') memo++;

//       return memo;
//     }, 0);
//   });
// }

// Keeper.prototype.askOneToStore = function(contact, key, val) {
//   debugger;

//   var addr = contact.addr;
//   addr = '127.0.0.1:' + addr.split(':')[1];
//   debugger;
//   return Q.ninvoke(request, 'post', {
//     url: 'http://:' + addr + '/put',
//     headers: {'content-type' : 'application/x-www-form-urlencoded'},
//     body: querystring.stringify({ key: key, val: val })
//   }).then(function(result) {
//     debugger;
//     console.log(result);
//   });
// }

Keeper.prototype.get = function(key) {
  var self = this;

  return this.storage()
    .get(key)
    .then(function(docs) {
      return docs.length ? docs : self.find(key);
    });
}

// Keeper.prototype.fetch = function(keys, fromAddr) {
//   return new KeeperAPI(fromAddr).get(keys);
// }

// Keeper.prototype.find = function(key) {
//   var deferred = Q.defer();

//   this.once('done:' + key, deferred.resolve);
//   this._client.download(key);

//   return deferred.promise.then(function(torrent) {
//     debugger;
//     return torrent.storage.files;
//   });

//   // var self = this;
//   // var peerEvent = 'peer:' + key;
//   // var deferred = Q.defer();

//   // this.on(peerEvent, fetchFromPeer);
//   // this._dht.lookup(key);

//   // var timeoutId = setTimeout(function() {
//   //   deferred.reject(new Error('timeout'));
//   // }, 10000);

//   // function fetchFromPeer(addr) {
//   //   self.fetch(key, addr)
//   //   .then(function(val) {
//   //     debugger;
//   //     self.put(key, val);
//   //     deferred.resolve(val);
//   //   });
//   // }

//   // return deferred.promise
//   //   .finally(function() {
//   //     clearTimeout(timeoutId);
//   //     self.removeListener(peerEvent, fetchFromPeer);
//   //   });
// }

Keeper.prototype.put = function(key, value) {
  var self = this;

  if (typeof value !== 'undefined') 
    return this.validate(key, value).then(function() {
      return self._doPut(key, value);
    });
  else {
    value = key;
    return Q.ninvoke(utils, 'getInfoHash', value).then(function(infoHash) {
      return self._doPut(infoHash, value);
    });
  }
}

Keeper.prototype._doPut = function(key, value) {
  var self = this;
  var valBuf = common.buffer(value);
  var valStr = common.string(value);

  return self.storage()
    .putOne(key, valStr)
    .then(function() {
      self.emit('put', key, valStr);
      self.seed(valBuf);
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

Keeper.prototype.port = function() {
  return this.config('address').port;
}

Keeper.prototype.torrentPort = function() {
  return this.config('address').torrentPort;
}

// Keeper.prototype.dhtPort = function() {
//   return this.config('address').dhtPort;
// }

function isFinished(promise) {
  var state = promise.inspect().state;
  return state !== 'unknown' && state !== 'pending';
}

function isTradleNode(addr) {
  return isOnLAN(addr);
}

function isOnLAN(addr) {
  return ip.address() === addr.split(':')[0];
}

function inMemoryStorage() {
  var map = {};
  return {
    putOne: function(key, val) {
      map[key] = val;
      return Q.resolve();
    },
    get: function(keys) {
      var vals = keys.map(function(k) {
        return map[k];
      });

      return Q.resolve(vals.filter(function(val) { 
        return val;
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
  assert(typeof value !== 'undefined', 'Missing required parameter: ' + value);
  return value;
}

module.exports = Keeper;