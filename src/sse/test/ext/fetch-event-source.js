// FetchEventSource against the EventSource processing model. Most vectors are
// taken from the web-platform-tests eventsource/ directory (the test each one
// comes from is named), fed through a stubbed fetch() that returns real
// Response objects with real ReadableStream bodies.
describe('FetchEventSource', function() {
  // Captured at load time, before any test installs fake timers.
  var realSetTimeout = window.setTimeout.bind(window)
  var encoder = new TextEncoder()

  function settle() {
    // A macrotask: every promise continuation queued so far has run by then.
    return new Promise(function(resolve) { realSetTimeout(resolve, 0) })
  }

  async function tick(clock, ms) {
    await settle()
    await clock.tickAsync(ms)
    await settle()
  }

  beforeEach(function() {
    var test = this
    this.realFetch = window.fetch
    this.requests = []
    window.fetch = function(url, init) {
      var request = { url: url, init: init }
      test.requests.push(request)
      return new Promise(function(resolve, reject) {
        request.resolve = resolve
        request.reject = reject
        if (init && init.signal) {
          init.signal.addEventListener('abort', function() {
            reject(new DOMException('aborted', 'AbortError'))
          })
        }
      })
    }
    this.clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  })

  afterEach(function() {
    if (this.source) {
      this.source.close()
    }
    window.fetch = this.realFetch
    this.clock.restore()
  })

  // Answers a pending request with a stream that the test writes to.
  function respond(request, opts) {
    opts = opts || {}
    var controller
    var nullBody = opts.status === 204 || opts.status === 205 || opts.status === 304
    var body = nullBody ? null : new ReadableStream({ start: function(c) { controller = c } })
    var headers = new Headers({ 'Content-Type': opts.contentType || 'text/event-stream' })
    Object.keys(opts.headers || {}).forEach(function(k) { headers.set(k, opts.headers[k]) })
    request.resolve(new Response(body, { status: opts.status || 200, headers: headers }))
    return {
      push: function(text) { controller.enqueue(typeof text === 'string' ? encoder.encode(text) : text) },
      end: function() { controller.close() },
      fail: function() { controller.error(new TypeError('network error')) }
    }
  }

  function open(test, url) {
    test.source = new htmx.FetchEventSource(url || '/stream', { withCredentials: true })
    test.messages = []
    test.errors = []
    test.source.addEventListener('message', function(e) { test.messages.push(e.data) })
    test.source.onerror = function(e) { test.errors.push(e.failure) }
    return test.source
  }

  it('sends the request an EventSource sends', async function() {
    open(this, '/stream?x=1')
    this.requests.should.have.lengthOf(1)
    var init = this.requests[0].init
    this.requests[0].url.should.equal(new URL('/stream?x=1', document.baseURI).href)
    init.headers.Accept.should.equal('text/event-stream')
    init.cache.should.equal('no-store')
    init.credentials.should.equal('include')
    init.redirect.should.equal('follow')
    ;(init.headers['Last-Event-ID'] === undefined).should.equal(true)
  })

  it('opens, then dispatches messages with data, origin and lastEventId (eventsource-onmessage)', async function() {
    var source = open(this)
    var opened = 0
    source.onopen = function() { opened++ }
    source.readyState.should.equal(source.CONNECTING)

    var stream = respond(this.requests[0])
    await settle()
    source.readyState.should.equal(source.OPEN)
    opened.should.equal(1)

    var last = null
    source.onmessage = function(e) { last = e }
    stream.push('id: 7\ndata: data\n\n')
    await settle()

    this.messages.should.deep.equal(['data'])
    last.origin.should.equal(location.origin)
    last.lastEventId.should.equal('7')
  })

  it('parses fields as specified (format-field-parsing)', async function() {
    open(this)
    var stream = respond(this.requests[0])
    stream.push('data:\0\ndata:  2\rData:1\ndata\0:2\ndata:1\r\0data:4\nda-ta:3\rdata_5\ndata:3\rdata:\r\n data:32\ndata:4\n\n')
    await settle()
    this.messages.should.deep.equal(['\0\n 2\n1\n3\n\n4'])
  })

  it('strips a leading BOM (format-bom)', async function() {
    open(this)
    var stream = respond(this.requests[0])
    stream.push(new Uint8Array([0xEF, 0xBB, 0xBF]))
    stream.push('data:1\n\n')
    await settle()
    this.messages.should.deep.equal(['1'])
  })

  it('strips one leading BOM and only one (format-bom-2)', async function() {
    open(this)
    var stream = respond(this.requests[0])
    stream.push(new Uint8Array([0xEF, 0xBB, 0xBF, 0xEF, 0xBB, 0xBF]))
    stream.push('data:1\n\n﻿data:2\n\ndata:3\n\n')
    await settle()
    this.messages.should.deep.equal(['3'])
  })

  it('ignores comments and unknown fields (format-comments, format-field-unknown)', async function() {
    open(this)
    var stream = respond(this.requests[0])
    stream.push(':\n:comment\ndata:1\nunknown: x\n: more\ndata:2\n\n')
    await settle()
    this.messages.should.deep.equal(['1\n2'])
  })

  it('dispatches named events and nothing for an empty data buffer (format-field-event, format-field-event-empty)', async function() {
    var source = open(this)
    var named = []
    source.addEventListener('ping', function(e) { named.push(e.data) })
    var stream = respond(this.requests[0])
    stream.push('event: ping\ndata: \n\nevent: ping\n\nevent:\ndata: plain\n\n')
    await settle()
    named.should.deep.equal([''])
    this.messages.should.deep.equal(['plain'])
  })

  it('treats CR at the end of one chunk and LF at the start of the next as one line ending', async function() {
    open(this)
    var stream = respond(this.requests[0])
    stream.push('data: a\r')
    await settle()
    stream.push('\ndata: b\r\n\r\n')
    await settle()
    this.messages.should.deep.equal(['a\nb'])
  })

  it('decodes UTF-8 split across chunks (format-utf-8)', async function() {
    open(this)
    var stream = respond(this.requests[0])
    var bytes = encoder.encode('data: oké…\n\n')
    stream.push(bytes.slice(0, 10))
    await settle()
    stream.push(bytes.slice(10))
    await settle()
    this.messages.should.deep.equal(['oké…'])
  })

  it('accepts a MIME type with parameters and in any case, and nothing else (format-mime-*)', async function() {
    var ok = ['text/event-stream; charset=utf-8', 'TEXT/Event-Stream', 'text/event-stream;']
    for (var i = 0; i < ok.length; i++) {
      var source = open(this)
      respond(this.requests[this.requests.length - 1], { contentType: ok[i] })
      await settle()
      source.readyState.should.equal(source.OPEN, ok[i])
      source.close()
    }

    var bad = ['text/html', 'text/event-stream-x', 'text/plain; x=text/event-stream']
    for (var j = 0; j < bad.length; j++) {
      var failed = open(this)
      respond(this.requests[this.requests.length - 1], { contentType: bad[j] })
      await settle()
      failed.readyState.should.equal(failed.CLOSED, bad[j])
      this.errors[0].kind.should.equal('content-type')
      this.errors[0].status.should.equal(200)
    }
  })

  it('fails the connection on any status but 200, with the status on the error (request-status-error)', async function() {
    var statuses = [204, 205, 210, 299, 401, 404, 410, 503]
    for (var i = 0; i < statuses.length; i++) {
      var source = open(this)
      var states = []
      source.onerror = function(e) { states.push([source.readyState, e.failure.kind, e.failure.status]) }
      respond(this.requests[this.requests.length - 1], { status: statuses[i] })
      await settle()
      states.should.deep.equal([[source.CLOSED, 'http', statuses[i]]])

      var before = this.requests.length
      await tick(this.clock, 120000)
      this.requests.length.should.equal(before, 'a failed connection must not reconnect (' + statuses[i] + ')')
    }
  })

  it('exposes the response headers on the failure, e.g. a proxy challenge', async function() {
    open(this)
    respond(this.requests[0], { status: 403, contentType: 'text/html', headers: { 'cf-mitigated': 'challenge' } })
    await settle()
    this.errors[0].kind.should.equal('http')
    this.errors[0].headers.get('cf-mitigated').should.equal('challenge')
  })

  it('reestablishes after a network error, CONNECTING before the error event', async function() {
    var source = open(this)
    var state = null
    source.onerror = function(e) { state = [source.readyState, e.failure.kind] }
    this.requests[0].reject(new TypeError('Failed to fetch'))
    await settle()

    state.should.deep.equal([source.CONNECTING, 'network'])
    await tick(this.clock, 2999)
    this.requests.should.have.lengthOf(1)
    await tick(this.clock, 1)
    this.requests.should.have.lengthOf(2)
  })

  it('reestablishes when the stream ends, discarding an unfinished event, and uses retry: (format-field-retry)', async function() {
    var source = open(this)
    var stream = respond(this.requests[0])
    stream.push('retry: 10\ndata: done\n\ndata: unfinished\n')
    await settle()
    stream.end()
    await settle()

    this.messages.should.deep.equal(['done'])
    this.errors.map(function(f) { return f.kind }).should.deep.equal(['ended'])
    source.readyState.should.equal(source.CONNECTING)
    await tick(this.clock, 9)
    this.requests.should.have.lengthOf(1)
    await tick(this.clock, 1)
    this.requests.should.have.lengthOf(2)
  })

  it('ignores a bogus or empty retry: field (format-field-retry-bogus, format-field-retry-empty)', async function() {
    open(this)
    var stream = respond(this.requests[0])
    stream.push('retry: 10x\nretry:\nretry: -5\ndata: x\n\n')
    await settle()
    stream.end()
    await settle()
    await tick(this.clock, 2999)
    this.requests.should.have.lengthOf(1)
    await tick(this.clock, 1)
    this.requests.should.have.lengthOf(2)
  })

  it('sends Last-Event-ID when reconnecting, ignores an id with NUL, and keeps an id set without data (last-event-id, format-field-id-null)', async function() {
    open(this)
    var stream = respond(this.requests[0])
    stream.push('retry: 1\nid: 1\ndata: a\n\nid: 2\u0000x\ndata: b\n\nid: 3\n\n')
    await settle()
    stream.end()
    await settle()
    await tick(this.clock, 1)

    this.requests.should.have.lengthOf(2)
    this.requests[1].init.headers['Last-Event-ID'].should.equal('3')
  })

  it('stops dispatching the rest of a chunk when a listener closes the source', async function() {
    var source = open(this)
    source.addEventListener('message', function() { source.close() })
    var stream = respond(this.requests[0])
    stream.push('data: 1\n\ndata: 2\n\n')
    await settle()

    this.messages.should.deep.equal(['1'])
    source.readyState.should.equal(source.CLOSED)
    this.errors.should.have.lengthOf(0)
  })

  it('does not reconnect when closed while waiting to', async function() {
    var source = open(this)
    this.requests[0].reject(new TypeError('Failed to fetch'))
    await settle()
    source.close()
    await tick(this.clock, 60000)
    this.requests.should.have.lengthOf(1)
    this.errors.should.have.lengthOf(1)
  })

  it('does not fire an error for its own abort on close', async function() {
    var source = open(this)
    respond(this.requests[0])
    await settle()
    source.close()
    await settle()
    this.errors.should.have.lengthOf(0)
    source.readyState.should.equal(source.CLOSED)
  })

  it('closes the stream on pagehide and reopens it when the page is restored, without an error', async function() {
    var source = open(this)
    respond(this.requests[0])
    await settle()

    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }))
    await settle()
    source.readyState.should.equal(source.CONNECTING)
    this.requests[0].init.signal.aborted.should.equal(true)

    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }))
    this.requests.should.have.lengthOf(2)
    respond(this.requests[1])
    await settle()
    source.readyState.should.equal(source.OPEN)
    this.errors.should.have.lengthOf(0)
  })

  it('waits for the browser to come back online, but not forever', async function() {
    var source = open(this)
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: function() { return false } })
    try {
      this.requests[0].reject(new TypeError('Failed to fetch'))
      await settle()
      await tick(this.clock, 30000)
      this.requests.should.have.lengthOf(1)

      window.dispatchEvent(new Event('online'))
      await tick(this.clock, 3000)
      this.requests.should.have.lengthOf(2)

      this.requests[1].reject(new TypeError('Failed to fetch'))
      await settle()
      await tick(this.clock, 59999)
      this.requests.should.have.lengthOf(2)
      await tick(this.clock, 1)
      this.requests.should.have.lengthOf(3)

      // The wait that timed out must not leave its online listener behind
      window.dispatchEvent(new Event('online'))
      await tick(this.clock, 3000)
      this.requests.should.have.lengthOf(3)
    } finally {
      delete navigator.onLine
      source.close()
    }
  })

  it('is what the extension creates when htmx.config.sseTransport is "fetch", and its failure reaches htmx:sseError', async function() {
    var savedFactory = htmx.createEventSource
    htmx.createEventSource = undefined
    htmx.config.sseTransport = 'fetch'
    try {
      var div = make('<div hx-ext="sse" sse-connect="/stream"></div>')
      var seen = null
      div.addEventListener('htmx:sseError', function(evt) {
        seen = [evt.detail.failure.kind, evt.detail.failure.status]
        evt.preventDefault()
      })
      this.requests.should.have.lengthOf(1)
      respond(this.requests[0], { status: 401 })
      await settle()

      seen.should.deep.equal(['http', 401])
      await tick(this.clock, 120000)
      this.requests.should.have.lengthOf(1)
    } finally {
      htmx.createEventSource = savedFactory
      htmx.config.sseTransport = 'eventsource'
      clearWorkArea()
    }
  })
})
