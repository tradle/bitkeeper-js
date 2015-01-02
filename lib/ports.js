var Q = require('q');
var natUpnp = require('nat-upnp');
var client = natUpnp.createClient();

function acquirePort(pub, priv) {
  return Q.nfcall(isMappingAvailable, pub, priv)
  .then(function() {
    return Q.ninvoke(client, 'portMapping', {
      public: pub,
      private: priv,
      ttl: 10
    });
  });
}

function isMappingAvailable(pub, priv, cb) {
  client.findGateway(function(err, gateway, myIp) {
    if (err) return cb(err);

    client.getMappings(function(err, mappings) {
      if (err) return cb(err);

      var conflict;

      mappings.some(function(mapping) {
        if (mapping.private.host !== myIp &&
            (mapping.public.port === pub || mapping.private.port === priv)) {
          conflict = mapping;
          return true;
        }
      });

      if (conflict) return cb(new Error('This mapping conflicts with an existing mapping'));

      cb();
    });
  });
}

function clearMappings(options) {
  options = options || { local: true };
  // var remoteHost;
  var ports = options.ports;
  var protocol = options.protocol;

  // return externalIp()
  // .then(function(ip) {
  //   remoteHost = ip;
    return Q.ninvoke(client, 'getMappings', options)
  // })
  .then(function(results) {
    var tasks = results.map(function(mapping) {
      // debugger;
      if (ports && ports.indexOf(mapping.public.port) === -1) return;
      if (protocol && mapping.protocol.toLowerCase() !== protocol) return;

      var pub = mapping.public;

      // if (!pub.host) pub.host = remoteHost;

      return Q.ninvoke(client, 'portUnmapping', {
        public: pub
      });
    });

    return Q.allSettled(tasks);
  });
}

function unmapPort(pub) {
  return clearMappings({
    ports: [pub]
  })
}

function externalIp() {
  return Q.ninvoke(client, 'externalIp');
}

// clearMappings().then(function() {  
//   return Q.all([
//     acquirePort(pubPort, privPort),
//     Q.ninvoke(client, 'externalIp'),
//     Q.ninvoke(app, 'listen', privPort, '127.0.0.1')
//   ]);
// }).spread(function(acquireResp, ip) {
//   // console.log('Port mapped, pub:', pubPort, 'priv:', privPort);
//   request('http://' + ip + ':' + pubPort, function(err, resp, body) {
//     if (err) return console.log(err);

//     console.log(body);
//   });
// }).catch(function(err) {
//   console.log('Error', err);
// });

module.exports = {
  // isMappingAvailable: isMappingAvailable,
  clearMappings: clearMappings,
  externalIp: externalIp,
  mapPort: acquirePort,
  unmapPort: unmapPort
}