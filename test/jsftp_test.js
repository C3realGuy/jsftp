/*
 * @package jsftp
 * @copyright Copyright(c) 2011 Ajax.org B.V. <info AT ajax DOT org>
 * @author Sergi Mansilla <sergi.mansilla@gmail.com>
 * @license https://github.com/sergi/jsFTP/blob/master/LICENSE MIT License
 */
/*global it describe beforeEach afterEach */

'use strict';

var assert = require('assert');
var Fs = require('fs');
var Ftp = require('../');
var Path = require('path');
var sinon = require('sinon');
var EventEmitter = require('events').EventEmitter;
var rimraf = require('rimraf');
var concat = require('concat-stream');
var unorm = require('unorm');

var ftpServer = require('./server');

// Write down your system credentials. This test suite will use OSX internal
// FTP server. If you want to test against a remote server, simply change the
// `host` and `port` properties as well.
var options = {
  user: 'user',
  pass: '12345',
  host: process.env.IP || '127.0.0.1',
  port: process.env.PORT || 7002,
  useList: true,
  cwd: '/',
  root: Path.join(process.cwd(), 'test'),
  tls: null
};

function getLocalFixturesPath(path) {
  return Path.join(process.cwd(), 'test', 'fixtures', path);
}

function getRemoteFixturesPath(path) {
  return Path.join('/', 'fixtures', path || '');
}

var remoteCWD = '/fixtures';
describe('jsftp test suite', function() {
  var ftp;
  before(function(done) {
    var _server = ftpServer.makeServer(options);
    _server.listen(options.port);
    setTimeout(done, 1000);
  });

  beforeEach(function(done) {
    rimraf(getLocalFixturesPath(''), function() {
      Fs.mkdirSync(getLocalFixturesPath(''));
      Fs.writeFileSync(getLocalFixturesPath('testfile.txt'), 'test');
      Fs.writeFileSync(getLocalFixturesPath('testfile2.txt'), 'test2');

      ftp = new Ftp(options);
      ftp.once('connect', done);
    });
  });

  afterEach(function(done) {
    setTimeout(function() {
      if (ftp) {
        ftp.destroy();
        ftp = null;
      }
      done();
    }, 50);
  });

  after(function() {  });

  it('test invalid password', function(next) {
    ftp.auth(
      options.user,
      options.pass + '_invalid',
      function(err, data) {
        assert.equal(err.code, 530);
        assert.equal(data, null);
        next();
      });
  });

  it('test initialize bad host', function(done) {
    var ftp2 = new Ftp({
      host: 'badhost',
      user: 'user',
      port: 21,
      pass: '12345'
    });

    ftp2.on('error', function(err) {
      assert.equal(err.code, 'ENOTFOUND');
      done();
    });
  });

  it('test initialize', function(next) {
    assert.equal(ftp.host, options.host);
    assert.equal(ftp.port, options.port);
    assert.equal(ftp.user, options.user);

    assert.ok(ftp instanceof EventEmitter);
    assert.equal(ftp.commandQueue.length, 0);

    next();
  });

  it('test parseResponse with mark', function(next) {
    var cb = sinon.spy();
    cb.expectsMark = {
      marks: [150]
    };
    var data = {
      code: 150,
      text: '150 File status okay; about to open data connection.',
      isMark: true
    };

    ftp.commandQueue = [
      { action:'retr fakefile.txt', callback: cb }
    ];
    ftp.parse = sinon.spy();

    var firstCmd = ftp.commandQueue[0];
    ftp.parseResponse(data);
    assert(ftp.parse.calledWith(data, firstCmd));
    next();
  });

  it('test parseResponse with no mark', function(next) {
    var cb = sinon.spy();
    var data = {
      code: 150,
      text: '150 File status okay; about to open data connection.',
      isMark: true
    };

    ftp.commandQueue = [
      { action: 'retr fakefile.txt', callback: cb }
    ];
    ftp.parse = sinon.spy();

    ftp.parseResponse(data);
    assert.equal(ftp.parse.callCount, 0);
    next();
  });

  it('test send function', function(next) {
    ftp.pipeline = {
      write: sinon.spy()
    };
    ftp.send();
    ftp.send('list /');
    assert.equal(ftp.pipeline.write.callCount, 1);
    assert(ftp.pipeline.write.calledWithExactly('list /\r\n'));
    next();
  });

  it('test parseResponse with ignore code', function(next) {
    var cb = sinon.spy();
    cb.expectsMark = {
      marks: [150],
      ignore: 226
    };
    var data1 = {
      code: 150,
      text: '150 File status okay; about to open data connection.',
      isMark: true
    };
    var data2 = {
      code: 226,
      text: '226 Transfer complete.',
      isMark: false
    };

    ftp.commandQueue = [
      { action: 'retr fakefile.txt', callback: cb },
      { action: 'list /', callback: function() {} }
    ];
    ftp.parse = sinon.spy();
    ftp.ignoreCmdCode = 150;

    ftp.parseResponse(data1);
    assert.equal(ftp.ignoreCmdCode, 226);
    ftp.parseResponse(data2);
    assert.equal(ftp.ignoreCmdCode, null);
    assert(ftp.parse.calledOnce);
    next();
  });

  it('test getFeatures', function(next) {
    ftp.getFeatures(function(err, feats) {
      assert.ok(!err);
      assert.ok(Array.isArray(feats));
      assert.ok(Array.isArray(ftp.features));
      assert.ok(ftp.system.length > 0);

      var feat = ftp.features[0];
      assert.ok(ftp.hasFeat(feat));
      assert.equal(false, ftp.hasFeat('madeup-feat'));
      assert.equal(false, ftp.hasFeat());
      assert.equal(false, ftp.hasFeat(null));
      assert.equal(false, ftp.hasFeat(''));
      assert.equal(false, ftp.hasFeat(0));
      next();
    });
  });

  it('test print working directory', function(next) {
    ftp.raw.pwd(function(err, res) {
      assert(!err, err);

      var code = parseInt(res.code, 10);
      assert.ok(code === 257, 'PWD command was not successful: ' + res.text);

      next();
    });
  });

  it('test switch CWD', function(next) {
    ftp.raw.cwd(remoteCWD, function(err, res) {
      assert.ok(!err, err);

      var code = parseInt(res.code, 10);
      assert.ok(code === 200 || code === 250, 'CWD command was not successful');

      ftp.raw.pwd(function(err, res) {
        assert.ok(!err, err);

        var code = parseInt(res.code, 10);
        assert.ok(code === 257, 'PWD command was not successful');
        assert.ok(res.text.indexOf(remoteCWD), 'Unexpected CWD');
        next();
      });
    });
  });

  it('test switch to unexistent CWD', function(next) {
    ftp.raw.cwd('/unexistentDir/', function(err, res) {
      var code = parseInt(res.code, 10);
      assert.ok(!!err);
      assert.equal(code, 550, 'A (wrong) CWD command was successful. It should have failed');
      next();
    });
  });

  it('test switch to unexistent CWD contains special string', function(next) {
    ftp.raw.cwd('/unexistentDir/user', function(err, res) {
      assert(err);
      var code = parseInt(res.code, 10);
      assert.equal(code, 550);
      next();
    });
  });

  it('test passive listing of current directory', function(next) {
    ftp.list(remoteCWD, function(err, res) {
      assert.ok(!err, err);
      assert.ok(res.length > 0);
      next();
    });
  });

  it('test passive listing of nonexisting directory', function(next) {
    ftp.list('does-not-exist/', function(err) {
      console.log('XYZ: ' + err);
      assert(err);
      assert.equal(typeof err, 'object');
      assert.ok(err.code === 450 || err.code === 550);
      next();
    });
  });

  it('test ftp node stat', function(next) {
    ftp.raw.pwd(function(err, res) {
      assert.ok(!err);
      var parent = new RegExp('.*"(.*)".*').exec(res.text)[1];
      var path = Path.resolve(parent + '/' + remoteCWD);
      ftp.raw.stat(path, function(err, res) {
        assert.ok(!err, res);
        assert.ok(res);

        assert.ok(res.code === 211 || res.code === 212 || res.code === 213);
        next();
      });
    });
  });

  it('test create and delete a directory', function(next) {
    var newDir = remoteCWD + '/ftp_test_dir';
    ftp.raw.mkd(newDir, function(err, res) {
      assert.ok(!err);
      assert.equal(res.code, 257);

      ftp.raw.rmd(newDir, function(err, res) {
        assert.ok(!err);
        next();
      });
    });
  });

  it('test create and delete a directory containing a space', function(next) {
    var newDir = remoteCWD + '/ftp test dür';
    ftp.raw.mkd(newDir, function(err, res) {
      assert.ok(!err);
      assert.equal(res.code, 257);

      ftp.raw.rmd(newDir, function(err, res) {
        assert.ok(!err);
        next();
      });
    });
  });

  it('test create and delete a file', function(next) {
    var filePath = getRemoteFixturesPath('file_ftp_test.txt');
    Fs.readFile(__filename, 'binary', function(err, data) {
      assert.ok(!err);
      var buffer = new Buffer(data, 'binary');
      ftp.put(buffer, filePath, function(hadError) {
        assert.ok(!hadError);

        assert.equal(buffer.length,
                     Fs.statSync(Path.join(process.cwd(), 'test/jsftp_test.js')).size);

        ftp.raw.dele(filePath, function(err, data) {
          assert.ok(!err);
          next();
        });
      });
    });
  });

  it('test save a remote copy of a local file', function(next) {
    this.timeout(10000);
    var filePath = getRemoteFixturesPath('file_ftp_test.txt');
    var onProgress = sinon.spy();
    ftp.on('progress', onProgress);
    ftp.put(__filename, filePath, function(err, res) {
      assert.ok(!err, err);
      assert(onProgress.called);

      var data = onProgress.args[0][0];
      assert.equal(data.filename, filePath);
      assert.equal(data.action, 'put');
      assert.ok(typeof data.transferred, 'number');

      ftp.raw.dele(filePath, function(err, data) {
        assert.ok(!err);
        next();
      });
    });
  });

  it('test passing a dir instead of file path to put should callback with error', function(next) {
    var localUploadPath = '.';
    var remoteFileName  = 'directory_file_upload_should_fail.txt';

    ftp.put(localUploadPath, remoteFileName, function(hadError) {
      assert.ok(hadError);
      next();
    });
  });

  it('test streaming put', function(next) {

    var readStream = Fs.createReadStream(__filename);
    var remoteFileName = 'file_ftp_test.txt';
    var filePath = getRemoteFixturesPath(remoteFileName);
    ftp.put(readStream, filePath, function(hadError) {
      assert.ok(!hadError);

      var uploadedFileSize = Fs.statSync(getLocalFixturesPath(remoteFileName)).size;
      var originalFileSize = Fs.statSync(__filename).size;
      assert.equal(uploadedFileSize, originalFileSize);

      ftp.raw.dele(filePath, function(err, data) {
        assert.ok(!err);
        next();
      });
    });
  });

  it('test rename a file', function(next) {
    var from = getRemoteFixturesPath('file_ftp_test.txt');
    var to = getRemoteFixturesPath('file_ftp_test_renamed.txt');
    Fs.readFile(__filename, 'binary', function(err, data) {
      assert.ok(!err, err);
      var buffer = new Buffer(data, 'binary');
      ftp.put(buffer, from, function(err, res) {
        assert.ok(!err, err);

        ftp.rename(from, to, function(err, res) {
          assert.ok(!err);

          assert.equal(buffer.length, Fs.statSync(__filename).size);

          ftp.raw.dele(to, function(err, data) {
            assert.ok(!err);
            next();
          });
        });
      });
    });
  });

  it('test get a file', function(next) {
    var localPath = getLocalFixturesPath('testfile.txt');
    var remotePath = getRemoteFixturesPath('testfile.txt');
    var realContents = Fs.readFileSync(localPath, 'utf8');
    var str = '';
    ftp.get(remotePath, function(err, socket) {
      assert.ok(!err, err);
      assert.ok(arguments.length === 2);
      socket.on('data', function(d) {
        str += d;
      });
      socket.on('close', function(hadErr) {
        assert.equal(realContents, str);
        next();
      });
      socket.resume();
    });
  });

  it('test get a file and save it locally', function(next) {
    var localPath = getLocalFixturesPath('testfile.txt');
    var remotePath = getRemoteFixturesPath('testfile.txt');
    var destination = localPath + '.copy';
    var onProgress = sinon.spy();
    ftp.on('progress', onProgress);

    Fs.unlink(destination, function() {
      Fs.readFile(localPath, 'utf8', function(err, realContents) {
        assert(!err);
        ftp.get(remotePath, destination, function(err) {
          assert.ok(!err, err);
          assert.ok(arguments.length < 2, arguments.length);
          var data = onProgress.args[0][0];
          assert.equal(data.filename, remotePath);
          assert.equal(data.action, 'get');
          assert.ok(typeof data.transferred, 'number');
          Fs.readFile(destination, 'utf8', function(err, data) {
            assert.ok(!err);
            assert.strictEqual(data, realContents);
            next();
          });
        });
      });
    });
  });

  it('test get a big file stream', function(next) {
    var remotePath = getRemoteFixturesPath('bigfile.test');
    var localPath = getLocalFixturesPath('bigfile.test');
    var data = (new Array(1 * 1024 * 1024)).join('x');
    var buffer = new Buffer(data, 'binary');

    Fs.writeFileSync(localPath, buffer);

    ftp.getGetSocket(remotePath, function(err, socket) {
      assert.ok(!err, err);

      socket.resume();

      var counter = 0;

      socket.on('data', function(data) {
        counter += data.length;
      });

      socket.on('close', function() {
        assert.equal(buffer.length, counter);

        ftp.raw.dele(remotePath, function(err, data) {
          assert.ok(!err);
          next();
        });
      });
    });
  });

  it('test put a big file stream', function(next) {
    var remotePath = getRemoteFixturesPath('bigfile.test');
    var data = (new Array(1 * 1024 * 1024)).join('x');

    ftp.getPutSocket(remotePath, function(err, socket) {
      assert.ok(!err, err);

      socket.write(data, function(err) {
        assert.ok(!err, err);
        socket.end();
      });
    }, function(err, res) {
      assert.ok(!err, err);

      ftp.raw.dele(remotePath, function(err, data) {
        assert.ok(!err);
        next();
      });
    });
  });

  it('test put a big file stream fail', function(next) {
    var remotePath = getRemoteFixturesPath('/nonexisting/path/to/file.txt');

    ftp.getPutSocket(remotePath, function(err, socket, res) {
      assert.ok(!!err, err);
    }, function(err, res) {
      assert.ok(!!err);
      next();
    });
  });

  it('test get fileList array', function(next) {
    var file1 = 'testfile.txt';

    ftp.raw.cwd(getRemoteFixturesPath(''), function() {
      ftp.ls('.', function(err, res) {
        assert.ok(!err, err);
        assert.ok(Array.isArray(res));

        res.forEach(assert.ok);
        res = res.map(function(file) {
          return file.name;
        });

        assert.ok(res.indexOf(file1) > -1);

        next();
      });
    });
  });

  it('test reconnect', function(next) {
    this.timeout(10000);
    ftp.raw.pwd(function(err, res) {
      if (err) {
        throw err;
      }

      ftp.socket.destroy();
      ftp.raw.quit(function(err, res) {
        if (err) {
          throw err;
        }
        next();
      });
    });
  });

  it('test attach event handlers: connect', function(_next) {
    var clientOnConnect = function() {
      client.auth(options.user, options.pass, next);
    };

    var next = function(err) {
      assert.ok(!err);
      client.destroy();
      _next();
    };

    var client = new Ftp({
      host: options.host,
      port: options.port,
    });
    client.on('connect', clientOnConnect);
  });

  it.skip('test PASV streaming: Copy file using piping', function(next) {
    var filePath = getRemoteFixturesPath('testfile.txt');
    var originalData = Fs.readFileSync(getLocalFixturesPath('testfile.txt'));
    ftp.getGetSocket(filePath, function(err, readable) {
      assert(!err, err);
      assert.ok(readable);

      readable.on('error', error);

      function error(err) {
        assert.ok(!err, err);
        if (readable.destroy) {
          readable.destroy();
        }

        next();
      }

      var remoteCopy = filePath + '.bak';
      ftp.getPutSocket(remoteCopy, function(err, socket) {
        assert.ok(!err, err);
        readable.pipe(socket);
        readable.resume();
      },

      function(hadError) {
        assert.ok(!hadError);

        var str = '';
        ftp.getGetSocket(remoteCopy, function(err, socket) {
          assert.ok(!err, err);

          socket.on('data', function(d) {
            str += d;
          });
          socket.on('close', function(hadErr) {
            assert.equal(originalData.toString('utf8'), str);
            next();
          });
          socket.resume();
        });
      });
    });
  });

  it('Test that streaming GET (RETR) retrieves a file properly', function(next) {
    var path = getLocalFixturesPath('testfile.txt');
    var originalData = Fs.readFileSync(path);
    ftp.getGetSocket(getRemoteFixturesPath('testfile.txt'), function(err, readable) {
      assert.ok(!err);
      var concatStream = concat(function(buffer) {
        assert.ok(!err);
        assert.equal(buffer.toString(), originalData.toString());
        next();
      });

      readable.on('error', function(err) {
        throw new Error(err);
      });

      readable.pipe(concatStream);
    });
  });

  it('Test that streaming GET (RETR) fails when a file is not present', function(next) {
    ftp.getGetSocket('unexisting/file/path', function(err, readable) {
      assert.ok(err);
      assert.equal(550, err.code);
      next();
    });
  });

  it('Test that streaming PUT (STOR) stores a file properly', function(next) {
    var path = getLocalFixturesPath('testfile.txt');
    var originalData = Fs.createReadStream(getLocalFixturesPath('testfile.txt'));
    originalData.pause();

    ftp.getPutSocket(getRemoteFixturesPath('testfile.txt.bak'), function(err, socket) {
      assert.ok(!err);
      originalData.pipe(socket);
      originalData.resume();

      var concatStream = concat(function(buffer) {
        assert.ok(!err);
        Fs.readFile(path, 'utf8', function(err, original) {
          assert.ok(!err);
          assert.equal(buffer.toString('utf8'), original);
          next();
        });
      });

      originalData.on('error', function(err) {
        throw new Error(err);
      });

      originalData.pipe(concatStream);
    });
  });

  it('Test that streaming PUT (STOR) fails when a file is not present', function(next) {
    ftp.getPutSocket('unexisting/file/path', function(err, socket) {
      assert.ok(err);
      next();
    });
  });

  it('Test that onConnect is called', function(next) {
    var ftp2 = new Ftp(options);
    ftp2.on('connect', function() {
      next();
    });
  });

  it('Test raw method with PWD', function(next) {
    ftp.raw('pwd', function(err, res) {
      assert(!err, err);

      var code = parseInt(res.code, 10);
      assert.ok(code === 257, 'Raw PWD command was not successful: ' + res.text);

      next();
    });
  });

  it('Test raw method with NOOP', function(next) {
    ftp.raw('noop', function(err, res) {
      assert(!err, err);

      var code = parseInt(res.code, 10);
      assert.ok(code === 200, 'Raw HELP command was not successful: ' + res.text);

      next();
    });
  });

  it('Test keep-alive with NOOP', function(next) {
    this.timeout(10000);
    ftp.keepAlive();
    ftp.keepAlive(1000);
    setTimeout(function() {
      ftp.destroy();
      next();
    }, 5000);
  });

  it('Test handling error on simultaneous PASV requests {#90}', function(next) {
    var file1 = getRemoteFixturesPath('testfile.txt');
    var file2 = getRemoteFixturesPath('testfile2.txt');

    var counter = 0;
    var args = [];
    function onDone() {
      counter += 1;
      if (counter === 2) {
        assert.ok(args.some(function(arg) {
          return arg instanceof Error;
        }));
        next();
      }
    }

    ftp.get(file1, function() {
      args.push(arguments[0]);
      onDone();
    });
    ftp.get(file2, function() {
      args.push(arguments[0]);
      onDone();
    });
  });

  it('test set binary type', function(next) {
    ftp.setType('I', function(err, res) {
      assert.ok(!err);
      assert.equal(ftp.type, 'I');
      assert.equal(res.code, 200);
      ftp.setType('I', function(err, res) {
        assert.ok(!err);
        assert.ok(!res);
        assert.equal(ftp.type, 'I');
        ftp.setType('A', function(err, res) {
          assert.ok(!err);
          assert.equal(ftp.type, 'A');
          assert.equal(res.code, 200);
          next();
        });
      });
    });
  });

  it('test listing a folder containing special UTF characters', function(next) {
    var dirName = unorm.nfc('_éàèùâêûô_');
    var newDir = Path.join(remoteCWD, dirName);
    ftp.raw.mkd(newDir, function(err, res) {
      assert.ok(!err);
      assert.equal(res.code, 257);
      var list = Fs.readdirSync(Path.join(__dirname, 'fixtures'));
      assert.ok(list.some(function(dir) {
        return unorm.nfc(dir.trim()) === dirName;
      }));
      next();
    });
  });
});
