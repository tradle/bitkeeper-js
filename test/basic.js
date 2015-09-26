
// interceptSetTimeout()

if (process.env.UTP) {
  console.log('USING UTP')
  // test with utp over multiplexed sockets
  require('multiplex-utp')
}

var test = require('tape')
var Q = require('q')
var DHT = require('bittorrent-dht')
var utils = require('tradle-utils')
var helper = require('./helper')
var baseConfig = require('../conf/config')
baseConfig.checkReplication = 5000
baseConfig.storage = false

var data = [
  'bill',
  'ted',
  'rufus'
].map(Buffer)

var coordinator = new DHT({ bootstrap: false })
coordinator.listen(testReplication)

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
        // helper.friendNext(_keepers.map(function (k) { return k.config('dht') }), '127.0.0.1')
        // helper.friendFirst(_keepers.map(function (k) { return k.config('dht') }), '127.0.0.1')
        helper.befriend(_keepers.map(function (k) {
          return k.config('dht')
        }), coordinator, '127.0.0.1')

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
        return Q.all(keepers.map(function (k) {
          return k.destroy()
        }))
      })
      .catch(t.error)
      .finally(function () {
        clearTimeout(timeoutId)
        coordinator.destroy()
        t.end()
        // watch()
      })
  })
}

// function watch () {
//   setInterval(function () {
//     var handles = process._getActiveHandles()
//     console.log(handles)
//     // console.log(handles.length, 'handles open')
//     // var types = handles.map(function (h) {
//     //   var type = h.constructor.toString().match(/function (.*?)\s*\(/)[1]
//     //   if (type === 'Socket') {
//     //     if (h instanceof dgram.Socket) type += ' (raw)'
//     //     if (h._tag) type += ' ' + h._tag
//     //   }

//     //   return type + (h._id || h._timeoutId) + h._type
//     // })

//     // console.log(types)
//   }, 2000).unref()
// }

// function interceptSetTimeout () {
//   ;['setTimeout', 'setInterval'].forEach(function (method) {
//     var id = 0
//     var orig = global[method]
//     global[method] = function () {
//       console.log(method)
//       var ret = orig.apply(this, arguments)
//       ret._timeoutId = id++
//       ret._type = method
//       console.log(ret)
//       return ret
//     }
//   })
// }
