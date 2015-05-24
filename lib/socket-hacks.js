require('sock-jack')
var override = require('./override')
override(require('net'), require('utp'))
