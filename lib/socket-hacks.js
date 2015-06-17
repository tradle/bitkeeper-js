// TODO: do this in a top level module
//   but check that it has been done here and throw an error otherwise

require('sock-plex')
var override = require('./override')
try {
  var net = require('net')
  var utp = require('utp')
  if (utp !== net && utp.connect !== net.connect) {
    // yes, force everyone to use utp
    override(net, utp)
  }
} catch (err) {}
