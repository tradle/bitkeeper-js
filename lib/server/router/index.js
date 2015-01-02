
'use strict';

module.exports = function(app) {
  app.use('/ping', require('./routes/ping'));
  app.use('/get', require('./routes/get'));
  app.use('/put', require('./routes/put'));
  app.use('/clear', require('./routes/clear'));
}