var test = require('tape');
var tapSpec = require('tap-spec');
var Q = require('q');
var net = require('net');
var debug = require('debug')('bitkeeper-test');
var Keeper = require('../');
var express = require('express');
var request = require('request');
var bufferEqual = require('buffer-equal');
var utils = require('tradle-utils');
var KeeperAPI = require('bitkeeperAPI');
var config = require('../conf/config');
var DHT = require('bittorrent-dht/client');
var ports = require('../lib/ports');
var crypto = require('crypto');
var log = console.log.bind(console);
var externalIp;
// config.storage = false;

var common = require('../lib/common');
var data = [];
for (var i = 0; i < 10; i++) {
  data[i] = crypto.randomBytes(1024);
}

// var ihTasks = data.map(function(d) {
//   return
// });

// var data = new Buffer('blah blah blah');
// var infoHash = '1b9e5f5732f61fbd6abb3411e979f3851919a52f'; //'7b780fa93e68d9cc1f3b1ff12f5500a366fc90ca'; //'170eb4759bf8d37e9a15099fc2f0404f5991861a';

// var dhtPath = path.join(__dirname, '../storage', 'testDHT.json');
// var initDht = common.dht(dhtPath)
//               .then(function(dht) {
//                 setInterval(function() {
//                   fs.writeFile(dhtPath, JSON.stringify(dht.toArray));
//                 }, 5000);

//                 return dht;
//               });
// var dhtHacked = (function hackDHT() {
//   return ports.externalIp().then(function(ip) {
//     var onData = DHT.prototype._onData;

//     DHT.prototype._onData = function(data, rinfo) {
//       var addr = rinfo.address;
//       var parts = addr.split(':');
//       if (parts[0] === ip) {
//         debugger;
//         rinfo.address = '127.0.0.1:' + parts[1];
//       }

//       return onData.apply(this, arguments);
//     };
//   });
// })();

test.createStream()
  .pipe(tapSpec())
  .pipe(process.stdout);

// test('port mapping', function(t) {
//   var externalIp;
//   var server1;
//   var server2;
//   var port1 = 8008;
//   var port2 = 8009;
//   Q.all([
//     ports.externalIp(),
//     ports.clearMappings([port1, port2])
//   ])
//   .spread(function(ip) {
//     externalIp = ip;
//     // externalIp = '127.0.0.1';

//     Q.all([
//       ports.mapPort(port1, port1),
//       ports.mapPort(port2, port2)
//     ]).then(function() {
//       server1 = net.createServer(function(conn) {
//         debugger;
//         conn.pipe(conn);
//       });

//       // server2 = net.createServer(function(conn) {
//       //   debugger;
//       //   conn.pipe(conn);
//       // });

//       var app = express();
//       app.get('/', function(req, res) {
//         res.status(200).end();
//       });

//       return Q.all([
//         Q.ninvoke(server1, 'listen', port1),
//         Q.ninvoke(app, 'listen', port2)
//       ]);
//     }).then(function() {
//       var conn = net.connect(port1, externalIp);
//       conn.on('connect', function() {
//         debugger;
//         conn.destroy();
//         t.pass();
//       });

//       conn.on('error', function (err) {
//         debugger;
//         console.log(err);
//         t.fail();
//       })

//       request('http://' + externalIp + ':' + port2, function(err, resp, body) {
//         t.error(err);
//         t.equal(resp.statusCode, 200);
//       });
//     });
//   });
// });

test('replication across all keepers', function(t) {
  var numInstances = 10;
  t.plan(data.length * (numInstances - 1));

  var numDone = 0;
  var dhts = [];
  var infoHashes = [];
  var keepers = [];
  var tasks = data.map(function(d, i) {
    return Q.ninvoke(utils, 'getInfoHash', d).then(function(infoHash) {
      infoHashes[i] = infoHash;
    })
  });

  tasks.push(
    ports.clearMappings({ local: false, protocol: 'tcp' })
  );

  Q.all(tasks)
  .catch(function(err) {
    debug('Error: ' + err.message);
    t.fail();
    process.exit();
  })
  .then(function() {
    for (var i = 0; i < numInstances; i++) {
      dhts.push(new DHT({ bootstrap: false }));
    }

    var tasks = dhts.map(function(dht, idx) {
      return Q.Promise(function(resolve) { 
        dht.listen(config.address.dhtPort + 50000 + idx, resolve);
      });
    });

    return Q.all(tasks);  
  })
  .then(function(results) {
    var lastDHT = dhts[dhts.length - 1];
    dhts[0].addNode('127.0.0.1:' + lastDHT.port, lastDHT.nodeId);

    for (var i = 1; i < dhts.length; i++) {
      var prev = dhts[i - 1];
      dhts[i].addNode('127.0.0.1:' + prev.port, prev.nodeId);
    }

    for (var i = 0; i < dhts.length; i++) {
      var kConfig = common.clone(config);
      kConfig.address.torrentPort = config.address.torrentPort + i;
      kConfig.address.dhtPort = config.address.dhtPort + i;
      kConfig.address.port = config.address.port + i;
      kConfig.dht = dhts[i];
      keepers.push(new Keeper(kConfig));
    }

    // keepers.forEach(function(keeper, i) {
    //   console.log('Keeper ' + i + ' has port ' + keeper.port() + ' and dhtPort ' + dhts[i].port);
    // });

    var kTasks = keepers.map(function(keeper) {
      return Q.Promise(function(resolve, reject) {
        keeper.on('ready', resolve);
        keeper.on('error', reject);
      });
    });

    return Q.all(kTasks);
  }).then(function() {
    infoHashes.forEach(function(infoHash, idx) {
      infoHashes[idx] = infoHash;
      var keeper = keepers[idx % numInstances];
      new KeeperAPI('127.0.0.1:' + keeper.port())
          // .put(infoHashes[idx], data[idx].toString());
          .put(infoHashes[idx], data[idx]);

        // .put(d);

        // keepers.forEach(function(k) {        
        //   k.on('done:' + infoHash, function(torrent) {
        //     var timesReplicated = keepers.reduce(function(memo, k) {
        //       return memo + (k.torrent(infoHash) ? 1 : 0);
        //     }, 0);

        //     t.pass('Keeper on port ' + k.port() + ' has ' + infoHash + ', replication count: ' + timesReplicated);
        //     // k.destroy().then(function() {
        //     //   if (++numDone === numInstances - 1) {
        //     //     t.end();
        //     //     process.exit();
        //     //   }
        //     // });
        //   });
        // })
      if (idx) return;

      setInterval(function() {
        debug('');
        debug('');
        infoHashes.forEach(function(infoHash) {
          var timesReplicated = keepers.reduce(function(memo, k) {
            return memo + (k.torrent(infoHash) ? 1 : 0);
          }, 0);

          debug(infoHash + ' replicated on ' + timesReplicated + ' keepers');
        });
      }, 5000);
    });

    // setTimeout(function() {
    //   dhts.forEach(function(dht) {
    //     dht.on('node', function(addr, nodeId) {
    //       var otherDHT;
    //       dhts.some(function(d) {
    //         // if (bufferEqual()
    //         if (bufferEqual(d.nodeId, nodeId)) {
    //           otherDHT = d;
    //           return true;
    //         }
    //       });

    //       console.log('Node mapped: ' + addr + ', dht idx: ' + dhts.indexOf(dht) + ', ' + dhts.indexOf(otherDHT));
    //     });

    //     dht.on('announce', function(addr, infoHash) {
    //       console.log('Received announce from ' + addr + ' for ' + infoHash + ', dht idx: ' + dhts.indexOf(dht));
    //     });
    //   });
      
    //   dhts[0].announce(infoHash, config.address.port);
    // }, 1000);
  });

  // var dht1 = new DHT({ bootstrap: false });
  // var dht2 = new DHT({ bootstrap: false });

  // dht1.listen(function (port1) {
  //   dht2.listen(function (port2) {
  //     // dht2.on('announce', function(addr, infoHash) {
  //     //   debugger;
  //     // });

  //     dht1.addNode('127.0.0.1:' + port2, dht2.nodeId);
  //     dht2.addNode('127.0.0.1:' + port1, dht1.nodeId);

  //     // dht1.announce(infoHash, config.address.port);

  //     var config2 = common.clone(config);
  //     config2.address.port++;

  //     config.dht = dht1;
  //     config2.dht = dht2;

  //     var k1 = new Keeper(config);
  //     var k2 = new Keeper(config2);

  //     k2.on('put', function(key, value) {
  //       debugger;
  //       t.equal(key, infoHash);
  //       t.ok(bufferEqual(new Buffer(value), data));
  //     });

  //     k1.put(data);
  //     dht2.on('announce', function() {
  //       k2.find(infoHash);
  //     });

  //     // .then(function() {
  //     //   debugger;
  //     //   return k1.replicate(infoHash, data, 1); 
  //     // })
  //     // .then(function() {
  //     //   return k2.find(infoHash)
  //     // })
  //     // .then(function() {
  //     //   debugger;
  //     //   t.pass();
  //     // })
  //     // .catch(function() {
  //     //   debugger;
  //     //   t.fail();
  //     // });
  //   });
  // });
});

// var k = new Keeper(config);

