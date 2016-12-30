/* jshint esversion: 6, mocha: true, node: true */

'use strict';

const tracing = require('../lib/tracing');

const assert = require('assert');
const avro = require('avsc');


suite('tracing', function () {

  const svc = avro.Service.forProtocol({
    protocol: 'Math',
    messages: {
      neg: {request: [{name: 'n', type: 'int'}], response: 'int'},
      abs: {request: [{name: 'n', type: 'int'}], response: 'int'}
    }
  });

  let client, server;

  setup(function (done) {
    server = createServer();
    client = createClient(server)
      .once('stub', function () {
        done();
      });
  });

  teardown(function () {
    client = undefined;
    server = undefined;
  });

  test('direct round-trip', function (done) {
    const trace = tracing.createTrace();
    server.onNeg(function (n, cb) {
      assert(this.getLocals().trace.uuid.equals(trace.uuid));
      assert.strictEqual(this.getStub().getServer(), server);
      cb(null, -n);
    });
    client.neg(10, {trace}, function (err, n) {
      assert.ifError(err);
      assert.equal(n, -10);
      assert.strictEqual(this.getLocals().trace, trace);
      assert.strictEqual(this.getStub().getClient(), client);
      assert.equal(trace.calls.length, 1);
      const call = trace.calls[0];
      assert.equal(call.name, 'neg');
      assert.equal(call.state, 'SUCCESS');
      assert.equal(call.downstreamCalls.length, 0);
      done();
    });
  });

  test('single hop round-trip', function (done) {
    server.onNeg(function (n, cb) {
        cb(null, -n);
      });
    const hopServer = createServer()
      .onNeg(function (n, cb) {
        // Delegate, but then fail.
        client.neg(n, {trace: this.getLocals().trace}, function (err, res) {
          assert.equal(res, -20);
          cb(new Error('bar'));
        });
      });
    createClient(hopServer)
      .once('stub', function () {
        const trace = tracing.createTrace();
        this.neg(20, {trace}, function (err) {
          assert(/bar/.test(err), err);
          assert.strictEqual(this.getLocals().trace, trace);
          assert.equal(trace.calls.length, 1);
          const call = trace.calls[0];
          assert.equal(call.state, 'ERROR');
          assert.equal(call.downstreamCalls.length, 1);
          const downstreamCall = call.downstreamCalls[0];
          assert.equal(downstreamCall.state, 'SUCCESS');
          done();
        });
      });
  });

  test('missing outgoing trace', function (done) {
    client.neg(5, function (err) {
      assert(/missing outgoing trace/.test(err), err);
      done();
    });
  });

  test('duplicate trace', function (done) {
    server.getStubs()[0].on('incomingCall', function (ctx) {
      // Pre-populate a trace.
      ctx.getLocals().trace = tracing.createTrace();
    });
    client.neg(3, {trace: tracing.createTrace()}, function (err) {
      assert(/duplicate trace/.test(err), err);
      done();
    });
  });

  function createClient(server) {
    const client = svc.createClient({server});
    client.use(tracing.clientTracing(client));
    return client;
  }

  function createServer() {
    const server = svc.createServer({silent: true});
    server.use(tracing.serverTracing(server));
    return server;
  }
});
