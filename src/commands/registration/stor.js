const Promise = require('bluebird');

module.exports = {
  directive: 'STOR',
  handler: function ({log, command} = {}) {
    if (!this.fs) return this.reply(550, 'File system not instantiated');
    if (!this.fs.write) return this.reply(402, 'Not supported by file system');

    const append = command.directive === 'APPE';
    let fileName = command.arg;
    
    fileName = fileName.replaceAll('*', '_');

    return this.connector.waitForConnection()
    .tap(() => this.commandSocket.pause())
    .then(() => Promise.try(() => this.fs.write(fileName, {append, start: this.restByteCount})))
    .then((fsResponse) => {
      let {stream, clientPath} = fsResponse;
      if (!stream && !clientPath) {
        stream = fsResponse;
        clientPath = fileName;
      }
      const serverPath = stream.path || fileName;

      const destroyConnection = (connection, reject) => (err) => {
        try {
          if (connection) {
            if (connection.writable) connection.end();
            connection.destroy(err);
          }
        } finally {
          reject(err);
        }
      };

      const streamPromise = new Promise((resolve, reject) => {
        stream.once('error', (err) => {
          log.error(`STOR: stream err: ${err}`);
          return destroyConnection(this.connector.socket, reject)(err);
        });
        stream.once('finish', () => {
          log.trace(`STOR: stream finish ...`);
          resolve()
        });
      });

      const socketPromise = new Promise((resolve, reject) => {
        log.trace(`STOR: begin pipe to stream`);
        this.connector.socket.pipe(stream, {end: false});
        this.connector.socket.once('close', () => {
          log.trace(`STOR: conn socket end`)
          if (stream.listenerCount('close')) stream.emit('close');
          else stream.end();
          resolve();
        });
        this.connector.socket.once('error', (err) => {
          log.error(`STOR: connector socket err: ${err}`);
          return destroyConnection(stream, reject)(err);
        });
      });

      this.restByteCount = 0;

      return this.reply(150).then(() => this.connector.socket && this.connector.socket.resume())
      .then(() => Promise.all([streamPromise, socketPromise]))
      .tap(() => this.emit('STOR', null, serverPath))
      .then(() => this.reply(226, clientPath))
      .finally(() => {
        // if(stream.destroy) stream.destroy();
        if(stream.close) stream.close();
      });
    })
    .catch(Promise.TimeoutError, (err) => {
      log.error(err);
      return this.reply(425, 'No connection established');
    })
    .catch((err) => {
      log.error(err);
      this.emit('STOR', err);
      return this.reply(550, err.message);
    })
    .finally(() => {
      this.connector.end();
      this.commandSocket.resume();
    });
  },
  syntax: '{{cmd}} <path>',
  description: 'Store data as a file at the server site'
};
