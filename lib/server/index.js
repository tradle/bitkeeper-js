
'use strict';

var express = require('express');
var bodyParser = require('body-parser');
var log = function() {
  return console.log.apply(console, arguments);
}

var domain = require('domain');
var common = require('../common');
var ports = require('../ports');
var router = require('./router');
// var request = require('request');

function createServer(keeper, port, callback) {
  var app = express();
  var mapping;

  app.set('keeper', keeper);
  app.use(function(req, res, next) {
    var requestDomain = domain.create();
    requestDomain.add(req);
    requestDomain.add(res);
    requestDomain.on('error', function(err) {
      console.log('Uncaught error, processing in domain error handler: ' + err.message);
      errorHandler(err, req, res);
    });

    res.on('close', requestDomain.dispose.bind(requestDomain));
    requestDomain.run(next);
  });

  app.use(function(req, res, next) {
    if (req.hostname !== 'localhost' && req.hostname !== '127.0.0.1') throw common.httpError('Only local requests permitted');

    next();
  });

  app.use(bodyParser.urlencoded({ extended: true })); // for parsing application/x-www-form-urlencoded

  /**
   * Routes
   */
  router(app);

  /**
   * Error Handling
   */
  app.use(errorHandler);

  // client.externalIp(function(err, ip) {
  //   console.log('External ip', ip);
  //   keeper.externalIp(ip);
  // });

  var ttl = 144000;

  process.on('exit', cleanup);
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
  process.on('uncaughtException', function(err) {
    log('Uncaught exception, caught in process catch-all: ' + err.message);
    log(err.stack);
  });

  // if (require.main === global.module) {
    // run directly, not as sub-app
  var portPromise = createPortMapping();
  portPromise.done(checkReady);

  var mappingIntervalId = setInterval(createPortMapping, ttl);
  var pubPort = port;
  var privPort = port;
  var serverIsUp;

  var server = app.listen(privPort, function() {
    log('Running on port: ' + privPort);
    // request('http://127.0.0.1:' + privPort + '/ping', function(err, resp, body) {
    //   console.log('Ping self: ' + resp.statusCode);
    // });

    serverIsUp = true;
    checkReady();
  });

  function checkReady() {
    if (serverIsUp && 
        portPromise.inspect().state === 'fulfilled' && 
        callback) {
      callback(); 
    }
  }

  function errorHandler(err, req, res, next) {
    debugger;
    if (res.finished) return;
    
    var code = err.status || 500;
    var msg = 'status' in err ? err.message : 'There was an error with your request. Please contact support@tradle.io';

    // log('Error:' + err.message);
    res.status(code).json({
      code: code,
      message: msg
    }, null, 2);
  }

  function createPortMapping() {
    return ports.mapPort(pubPort, privPort).then(function() {
      mapping = { 'public': pubPort, 'private': privPort };
    });
  }

  function cleanup() {
    if (!server) return;

    console.log('CLEANUP');
    if (server) {
      server.close();
      server = null;
    }

    if (mapping) {
      clearInterval(mappingIntervalId);
      ports.unmapPort(mapping['public']);
      mapping = null;
    }

    setTimeout(process.exit.bind(process), 1000);
  }

  return app;
}

module.exports = {
  create: createServer
};