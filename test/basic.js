var taptest = require('tape');
var Q = require('q');
var Keeper = require('../');
var utils = require('tradle-utils');
var config = require('../conf/config');
var DHT = require('bittorrent-dht/client');
var crypto = require('crypto');
config.storage = false;

var common = require('../lib/common');
var data = [];
for (var i = 0; i < 3; i++) {
  data[i] = crypto.randomBytes(1024);
}

taptest('replication across all keepers', function(t) {
  var numInstances = 3;
  var numPlanned = data.length * numInstances;
  var timeoutId = setTimeout(function() {
    t.fail('Timed out')
    t.end()
  }, 10000 * Math.ceil(numPlanned / 100));

  var dhts = [];
  var infoHashes = [];
  var keepers = [];
  var tasks = data.map(function(d, i) {
    return Q.ninvoke(utils, 'getInfoHash', d).then(function(infoHash) {
      infoHashes[i] = infoHash;
    })
  });

  Q.all(tasks)
    .then(function() {
      for (var i = 0; i < numInstances; i++) {
        dhts.push(new DHT({
          bootstrap: false
        }));
      }

      var tasks = dhts.map(function(dht, idx) {
        return Q.Promise(function(resolve) {
          dht.listen(config.dhtPort + 50000 + idx, resolve);
        });
      });

      return Q.all(tasks);
    })
    .then(function(results) {
      friendNext(dhts);

      var configs = dhts.map(function(dht, i) {
        var kConfig = common.clone(config);
        kConfig.torrentPort = config.torrentPort + i;
        kConfig.dhtPort = config.dhtPort + i;
        kConfig.dht = dht;
        return kConfig;
      });

      // the port mapper doesn't like to be gang banged
      return startInSeries(configs);
    }).then(function(_keepers) {
      keepers = _keepers;
      // wait for every torrent to be replicated on every keeper
      return Q.all(infoHashes.map(function(infoHash, idx) {
        infoHashes[idx] = infoHash;
        var kIdx = idx % numInstances;
        var keeper = keepers[kIdx];
        var allDone = Q.all(keepers.map(function(k, i) {
          var deferred = Q.defer();
          k.on('done:' + infoHash, function(torrent) {
            var timesReplicated = keepers.reduce(function(memo, k) {
              var torrent = k._client.get(infoHash);
              if (torrent && torrent.files[0] && torrent.files[0].done) memo++;

              return memo;
            }, 0);

            t.pass('Keeper ' + i + ' has ' + infoHash + ', replication count: ' + timesReplicated + '/' + keepers.length);
            deferred.resolve();
          });

          return deferred.promise;
        }))

        // console.log('Saving ' + infoHashes[idx] + ' to Keeper ' + kIdx);
        keeper.put(infoHash, data[idx]);
        return allDone;
      }))
    })
    .then(function() {
      return Q.allSettled(keepers.map(function(k) {
        return k.destroy();
      }))
    })
    .catch(function(err) {
      t.fail(err.message);
    })
    .finally(function() {
      clearTimeout(timeoutId);
      t.end();
    })
});

function startInSeries(configs) {
  return configs.reduce(function(promise, config) {
    return promise.then(function(keepers) {
      return Q.Promise(function(resolve, reject) {
        var k = new Keeper(config);
        k.on('ready', function() {
          keepers.push(k);
          resolve(keepers);
        })

        k.on('error', reject);
      });
    });
  }, Q.all([]));
}

/**
 *  Everyone friends the guy in front of them
 *  This should guarantee that anyone can find anyone else (with enough queries)
 */
function friendNext(dhts) {
  var l = dhts.length
  for (var i = 0; i < l; i++) {
    var next = dhts[(i + 1) % l]
    dhts[i].addNode('127.0.0.1:' + next.port, next.nodeId)
  }
}
