require('../lib/socket-hacks')
var test = require('tape')
var Q = require('q')
var utils = require('tradle-utils')
var helper = require('./helper')
var baseConfig = require('../conf/config')
baseConfig.checkReplication = 5000
baseConfig.storage = false

var data = [
  'bill',
  'ted',
  'rufus'
].map(function (d) {
  return new Buffer(d)
})

testReplication()
// testReplication(true)

function testReplication (external) {
  test('replication across all keepers', function (t) {
    var numInstances = 3
    var numPlanned = data.length * numInstances
    var timeoutId = setTimeout(function () {
      t.fail('Timed out')
      t.end()
    }, 100000 * Math.ceil(numPlanned / 100))

    var infoHashes = []
    var keepers
    var tasks = data.map(function (d, i) {
      return Q.ninvoke(utils, 'getInfoHash', d).then(function (infoHash) {
        infoHashes[i] = infoHash
      })
    })

    Q.all(tasks)
      .then(function () {
        return helper.createKeepers(numInstances)
      })
      .then(function (_keepers) {
        helper.friendNext(_keepers.map(function (k) { return k.config('dht') }), '127.0.0.1')
        keepers = _keepers
        // wait for every torrent to be replicated on every keeper
        return Q.all(infoHashes.map(function (infoHash, idx) {
          infoHashes[idx] = infoHash
          var kIdx = idx % numInstances
          var keeper = keepers[kIdx]
          var allDone = Q.all(keepers.map(function (k, i) {
            var deferred = Q.defer()
            k.once('done:' + infoHash, function (torrent) {
              var timesReplicated = keepers.reduce(function (memo, k) {
                var torrent = k._client.get(infoHash)
                if (torrent && torrent.storage && torrent.storage.done) memo++

                return memo
              }, 0)

              t.pass('Keeper ' + i + ' has ' + infoHash + ', replication count: ' + timesReplicated + '/' + keepers.length)
              deferred.resolve()
            })

            return deferred.promise
          }))

          // console.log('Saving ' + infoHashes[idx] + ' to Keeper ' + kIdx)
          keeper.put(infoHash, data[idx])
          return allDone
        }))
      })
      .then(function () {
        return Q.allSettled(keepers.map(function (k) {
          return k.destroy()
        }))
      })
      .catch(function (err) {
        t.error(err.message)
      })
      .finally(function () {
        clearTimeout(timeoutId)
        t.end()
      })
  })
}
