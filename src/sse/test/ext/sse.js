describe('sse extension', function() {
  function mockEventSource() {
    var listeners = {}
    var mockEventSource = {
      _listeners: listeners,
      removeEventListener: function(name, l) {
        listeners[name] = listeners[name].filter(function(elt, idx, arr) {
          if (arr[idx] === l) {
            return false
          }
          return true
        })
      },
      addEventListener: function(message, l) {
        if (!listeners[message]) {
          listeners[message] = []
        }
        listeners[message].push(l)
      },
      sendEvent: function(eventName, data) {
        this.readyState.should.equal(EventSource.OPEN)
        var eventListeners = listeners[eventName]
        if (eventListeners) {
          eventListeners.forEach(function(listener) {
            var event = htmx._('makeEvent')(eventName)
            event.data = data
            listener(event)
          })
        }
      },
      close: function() {
        this.readyState = EventSource.CLOSED
      },
      connect: function(url) {
        this.url = url
        setTimeout(function() {
          if (mockEventSource.failConnections) {
            mockEventSource.readyState = EventSource.CLOSED
            if (typeof mockEventSource.onerror === 'function') {
              mockEventSource.onerror('Simulated EventSource connection failure')
            }
          } else {
            mockEventSource.readyState = EventSource.OPEN
            if (typeof mockEventSource.onopen === 'function') {
              mockEventSource.onopen()
            }
          }
        }, 0)
      },
      simulateConnectionError: function() {
        this.close()
        if (typeof this.onerror === "function") {
          this.onerror()
        }
      },
      /** @type {EventSource.CONNECTING|EventSource.OPEN|EventSource.CLOSED|0|1|2} */
      readyState: EventSource.CONNECTING,
      failConnections: false,
    }
    return mockEventSource
  }

  beforeEach(function() {
    this.server = makeServer()
    this.closeType = ""
    this.clock = sinon.useFakeTimers();
    var test = this
    clearWorkArea()
    this.eventSources = []
    htmx.createEventSource = function(url) {
      var eventSource = mockEventSource()
      test.eventSource = eventSource
      test.eventSources.push(eventSource)
      eventSource.connect(url)
      return eventSource
    }
  })
  afterEach(function() {
    this.server.restore()
    this.clock.restore();
    clearWorkArea()
    htmx.config.sseReconnectDelay = 'exponential'
  })

  it('correctly subscribes to events', function() {
    make('<div hx-ext="sse" sse-connect="/foo">' +
            '<div sse-connect="/foo">' +
            '<div id="d1" hx-trigger="sse:e1" hx-get="/d1">div1</div>' +
            '</div>' +
            '</div>')
    this.clock.tick(1)

    this.eventSource.url.should.be.equal('/foo');
    this.eventSource._listeners.e1.should.be.lengthOf(1)
  })

  it('correctly behaves when ignored', function() {
    make('<div hx-ext="sse" sse-connect="/foo">' +
            '<div hx-ext="ignore:sse" sse-connect="/foo">' +
            '<div id="d1" hx-trigger="sse:e1" hx-get="/d1">div1</div>' +
            '</div>' +
            '</div>');
    this.clock.tick(1)

    this.eventSource.url.should.be.equal('/foo');
    (this.eventSource._listeners.e1 == undefined).should.be.true
  })

  it('handles basic sse triggering', function() {
    this.server.respondWith('GET', '/d1', 'div1 updated')
    this.server.respondWith('GET', '/d2', 'div2 updated')

    var div = make('<div hx-ext="sse" sse-connect="/foo">' +
            '<div id="d1" hx-trigger="sse:e1" hx-get="/d1">div1</div>' +
            '<div id="d2" hx-trigger="sse:e2" hx-get="/d2">div2</div>' +
            '</div>')
    this.clock.tick(1)

    this.eventSource.sendEvent('e1')
    this.server.respond()
    byId('d1').innerHTML.should.equal('div1 updated')
    byId('d2').innerHTML.should.equal('div2')

    this.eventSource.sendEvent('e2')
    this.server.respond()
    byId('d1').innerHTML.should.equal('div1 updated')
    byId('d2').innerHTML.should.equal('div2 updated')
  })

  it('supports hx-trigger\'s multiple triggers syntax', function() {
    this.server.respondWith('GET', '/d1', 'div1 updated')
    this.server.respondWith('GET', '/d2', 'div2 updated')
    this.server.respondWith('GET', '/d3', 'div3 updated')

    var div = make('<div hx-ext="sse" sse-connect="/foo">' +
      '<div id="d1" hx-trigger="click, whatever from:body, sse:e1" hx-get="/d1">div1</div>' +
      '<div id="d2" hx-trigger="keyup, sse:e2, someTrigger" hx-get="/d2">div2</div>' +
      '<div id="d3" hx-trigger="sse:e3, anotherTrigger" hx-get="/d3">div3</div>' +
      '</div>')
    this.clock.tick(1)

    this.eventSource.sendEvent('e1')
    this.server.respond()
    byId('d1').innerHTML.should.equal('div1 updated')
    byId('d2').innerHTML.should.equal('div2')
    byId('d3').innerHTML.should.equal('div3')

    this.eventSource.sendEvent('e2')
    this.server.respond()
    byId('d1').innerHTML.should.equal('div1 updated')
    byId('d2').innerHTML.should.equal('div2 updated')
    byId('d3').innerHTML.should.equal('div3')

    this.eventSource.sendEvent('e3')
    this.server.respond()
    byId('d1').innerHTML.should.equal('div1 updated')
    byId('d2').innerHTML.should.equal('div2 updated')
    byId('d3').innerHTML.should.equal('div3 updated')
  })

  it('does not trigger events that arent named', function() {
    this.server.respondWith('GET', '/d1', 'div1 updated')

    var div = make('<div hx-ext="sse" sse-connect="/foo">' +
            '<div id="d1" hx-trigger="sse:e1" hx-get="/d1">div1</div>' +
            '</div>')
    this.clock.tick(1)

    this.eventSource.sendEvent('foo')
    this.server.respond()
    byId('d1').innerHTML.should.equal('div1')

    this.eventSource.sendEvent('e2')
    this.server.respond()
    byId('d1').innerHTML.should.equal('div1')

    this.eventSource.sendEvent('e1')
    this.server.respond()
    byId('d1').innerHTML.should.equal('div1 updated')
  })

  it('does not trigger events not on descendents', function() {
    this.server.respondWith('GET', '/d1', 'div1 updated')

    var div = make('<div hx-ext="sse" sse-connect="/foo"></div>' +
            '<div id="d1" hx-trigger="sse:e1" hx-get="/d1">div1</div>')
    this.clock.tick(1)

    this.eventSource.sendEvent('foo')
    this.server.respond()
    byId('d1').innerHTML.should.equal('div1')

    this.eventSource.sendEvent('e2')
    this.server.respond()
    byId('d1').innerHTML.should.equal('div1')

    this.eventSource.sendEvent('e1')
    this.server.respond()
    byId('d1').innerHTML.should.equal('div1')
  })

  it('is closed after removal, hx-trigger', function() {
    this.server.respondWith('GET', '/test', 'Clicked!')
    var div = make('<div hx-get="/test" hx-swap="outerHTML" hx-ext="sse" sse-connect="/foo">' +
            '<div id="d1" hx-trigger="sse:e1" hx-get="/d1">div1</div>' +
            '</div>')
    htmx.on(div, "htmx:sseClose", (evt) => {
      this.closeType = evt.detail.type
    })
    this.clock.tick(1)
    div.click()

    this.server.respond()
    this.closeType.should.equal("nodeReplaced")
    this.eventSource.readyState.should.equal(EventSource.CLOSED)
  })

  it('is closed after removal, hx-swap', function() {
    this.server.respondWith('GET', '/test', 'Clicked!')
    var div = make('<div hx-get="/test" hx-swap="outerHTML" hx-ext="sse" sse-connect="/foo">' +
            '<div id="d1" hx-swap="e1" hx-get="/d1">div1</div>' +
            '</div>')
    htmx.on(div, "htmx:sseClose", (evt) => {
      this.closeType = evt.detail.type
    })
    this.clock.tick(1)
    div.click()

    this.server.respond()
    this.closeType.should.equal("nodeReplaced")
    this.eventSource.readyState.should.equal(EventSource.CLOSED)
  })

  it('is closed after removal with no close and activity, hx-trigger', function() {
    var div = make('<div hx-get="/test" hx-swap="outerHTML" hx-ext="sse" sse-connect="/foo">' +
            '<div id="d1" hx-trigger="sse:e1" hx-get="/d1">div1</div>' +
            '</div>')
    this.clock.tick(1)
    div.parentElement.removeChild(div)

    htmx.on(div, "htmx:sseClose", (evt) => {
      this.closeType = evt.detail.type
    })

    this.eventSource.sendEvent('e1')
    this.closeType.should.equal("nodeMissing")
    this.eventSource.readyState.should.equal(EventSource.CLOSED)
  })

  it('is closed after close message from server', function() {
    var div = make('<div hx-ext="sse" sse-connect="/foo" sse-close="close">' +
            '<div id="d1" sse-swap="e1"></div>' +
            '</div>');
    htmx.on(div, "htmx:sseClose", (evt) => {
      this.closeType = evt.detail.type
    })
    this.clock.tick(1)
    this.eventSource.readyState.should.equal(EventSource.OPEN);
    this.eventSource.sendEvent("close");
    this.closeType.should.equal("message")
    this.eventSource.readyState.should.equal(EventSource.CLOSED);
  })

  it('is closed after close message from server in nested content', function() {
    var div = make('<div hx-ext="sse"><div sse-connect="/foo" sse-close="close">' +
            '<div id="d1" sse-swap="e1"></div>' +
            '</div></div>');

    htmx.on(div, "htmx:sseClose", (evt) => {
      this.closeType = evt.detail.type
    })
    this.clock.tick(1)

    this.eventSource.readyState.should.equal(EventSource.OPEN);
    this.eventSource.sendEvent("close");
    this.closeType.should.equal("message")
    this.eventSource.readyState.should.equal(EventSource.CLOSED);
  })
  it('is closed after close message from server, non-nested', function(){
    var div = make(`<p
        hx-ext="sse"
        sse-connect="/chat"
        sse-close="close"
        id="message"
        sse-swap="message"
      ></p>`
    )
     htmx.on(div, "htmx:sseClose", (evt) => {
      this.closeType = evt.detail.type;
    });
    this.clock.tick(1)
    this.eventSource.readyState.should.equal(EventSource.OPEN);
    this.eventSource.sendEvent('close', '<p></p>')

    this.closeType.should.equal('message')
    this.eventSource.readyState.should.equal(EventSource.CLOSED);
  })

  it('is not listening for events after hx-swap element removed', function() {
    var div = make('<div hx-ext="sse" sse-connect="/foo">' +
        '<div id="d1" hx-swap="innerHTML" sse-swap="e1, e2">div1</div>' +
        '<div id="d2" hx-swap="innerHTML" sse-swap="e2">div1</div>' +
        '</div>')
    this.clock.tick(1)
      this.eventSource._listeners.e1.should.be.lengthOf(1)
      this.eventSource._listeners.e2.should.be.lengthOf(2)
      div.removeChild(byId('d1'))
      this.eventSource.sendEvent('e1', 'Test')
      this.eventSource.sendEvent('e2', 'Test')
      this.eventSource._listeners.e1.should.be.empty
      this.eventSource._listeners.e2.should.be.lengthOf(1)
      div.removeChild(byId('d2'))
      this.eventSource.sendEvent('e1', 'Test')
      this.eventSource.sendEvent('e2', 'Test')
      this.eventSource._listeners.e1.should.be.empty
      this.eventSource._listeners.e2.should.be.empty
  })

  it('is not listening for events after hx-trigger element removed', function() {
    this.server.respondWith('GET', '/test', function(xhr) {
      xhr.respond(200, {})
    })
    var div = make('<div hx-ext="sse" sse-connect="/foo">' +
      '<div id="d1" hx-get="/test" hx-target="this" hx-swap="innerHTML" hx-trigger="sse:e1, sse:e2">div1</div>' +
      '<div id="d2" hx-get="/test" hx-target="this" hx-swap="innerHTML" hx-trigger="sse:e2">div1</div>' +
      '</div>')
    this.clock.tick(1)
    this.eventSource._listeners.e1.should.be.lengthOf(1)
    this.eventSource._listeners.e2.should.be.lengthOf(2)
    div.removeChild(byId('d1'))
    this.eventSource.sendEvent('e1', 'Test')
    this.eventSource.sendEvent('e2', 'Test')
    this.eventSource._listeners.e1.should.be.empty
    this.eventSource._listeners.e2.should.be.lengthOf(1)
    div.removeChild(byId('d2'))
    this.eventSource.sendEvent('e1', 'Test')
    this.eventSource.sendEvent('e2', 'Test')
    this.eventSource._listeners.e1.should.be.empty
    this.eventSource._listeners.e2.should.be.empty
  })

  // sse and hx-trigger handlers are distinct
  it('is closed after removal with no close and activity, sse-swap', function() {
    var div = make('<div hx-get="/test" hx-swap="outerHTML" hx-ext="sse" sse-connect="/foo">' +
            '<div id="d1" sse-swap="e1" hx-get="/d1">div1</div>' +
            '</div>')
    this.clock.tick(1)
    div.parentElement.removeChild(div)
    this.eventSource.sendEvent('e1')
    this.eventSource.readyState.should.equal(EventSource.CLOSED)
  })

  it('swaps content properly on SSE swap', function() {
    var div = make('<div hx-ext="sse" sse-connect="/event_stream">\n' +
            '  <div id="d1" sse-swap="e1"></div>\n' +
            '  <div id="d2" sse-swap="e2"></div>\n' +
            '</div>\n')
    this.clock.tick(1)
    byId('d1').innerText.should.equal('')
    byId('d2').innerText.should.equal('')
    this.eventSource.sendEvent('e1', 'Event 1')
    byId('d1').innerText.should.equal('Event 1')
    byId('d2').innerText.should.equal('')
    this.eventSource.sendEvent('e2', 'Event 2')
    byId('d1').innerText.should.equal('Event 1')
    byId('d2').innerText.should.equal('Event 2')
  })

  it('swaps swapped in content', function() {
    var div = make('<div hx-ext="sse" sse-connect="/event_stream">\n' +
            '<div id="d1" sse-swap="e1" hx-swap="outerHTML"></div>\n' +
            '</div>\n'
    )
    this.clock.tick(1)

    this.eventSource.sendEvent('e1', '<div id="d2" sse-swap="e2"></div>')
    this.eventSource.sendEvent('e2', 'Event 2')
    byId('d2').innerText.should.equal('Event 2')
  })

  it('works in a child of an hx-ext="sse" element', function() {
    var div = make('<div hx-ext="sse">\n' +
            '<div id="d1" sse-connect="/event_stream" sse-swap="e1">div1</div>\n' +
            '</div>\n'
    )
    this.clock.tick(1)
    this.eventSource.sendEvent('e1', 'Event 1')
    byId('d1').innerText.should.equal('Event 1')
  })

  it('only adds sseEventSource to elements with sse-connect', function() {
    var div = make('<div hx-ext="sse" sse-connect="/event_stream" >\n' +
            '<div id="d1" sse-swap="e1"></div>\n' +
            '</div>');
    this.clock.tick(1);

    (byId('d1')['htmx-internal-data'].sseEventSource == undefined).should.be.true

    // Even when content is swapped in
    this.eventSource.sendEvent('e1', '<div id="d2" sse-swap="e2"></div>');

    (byId('d2')['htmx-internal-data'].sseEventSource == undefined).should.be.true
  })

  it('triggers events with naked hx-trigger', function() {
    var div = make( '<div hx-ext="sse"><div sse-connect="/foo"><div id="d2" hx-trigger="sse:e2">div2</div></div></div>')
    this.clock.tick(1)

    let triggerCounter = 0
    div.addEventListener("htmx:trigger", () => triggerCounter++)
    let sseMessageCounter = 0
    div.addEventListener("htmx:sseMessage", () => sseMessageCounter++)

    this.eventSource.sendEvent('e2')

    triggerCounter.should.be.equal(1)
    sseMessageCounter.should.be.equal(1)
  })

  it('initializes connections in swapped content', function() {
    this.server.respondWith('GET', '/d1', '<div><div sse-connect="/foo"><div id="d2" hx-trigger="sse:e2" hx-get="/d2">div2</div></div></div>')
    this.server.respondWith('GET', '/d2', 'div2 updated')

    var div = make('<div hx-ext="sse" hx-get="/d1"></div>')
    this.clock.tick(1)
    div.click()

    this.server.respond()
    this.clock.tick(1)
    this.eventSource.sendEvent('e2')
    this.server.respond()

    byId('d2').innerHTML.should.equal('div2 updated')
  })

  it('creates an eventsource on elements with sse-connect', function() {
    var div = make('<div hx-ext="sse"><div id="d1"sse-connect="/event_stream"></div></div>');
    this.clock.tick(1);

    (byId('d1')['htmx-internal-data'].sseEventSource == undefined).should.be.false
  })

  it('raises htmx:sseBeforeMessage when receiving message from the server', function() {
    var myEventCalled = false

    function handle(evt) {
      myEventCalled = true
    }

    htmx.on('htmx:sseBeforeMessage', handle)

    var div = make('<div hx-ext="sse" sse-connect="/event_stream" sse-swap="e1"></div>')
    this.clock.tick(1)

    this.eventSource.sendEvent('e1', '<div id="d1"></div>')

    myEventCalled.should.be.true

    htmx.off('htmx:sseBeforeMessage', handle)
  })

  it('cancels swap when htmx:sseBeforeMessage was cancelled', function() {
    var myEventCalled = false

    function handle(evt) {
      myEventCalled = true
      evt.preventDefault()
    }

    htmx.on('htmx:sseBeforeMessage', handle)

    var div = make('<div hx-ext="sse" sse-connect="/event_stream" sse-swap="e1"><div id="d1">div1</div></div>')
    this.clock.tick(1)

    this.eventSource.sendEvent('e1', '<div id="d1">replaced</div>')

    myEventCalled.should.be.true

    byId('d1').innerHTML.should.equal('div1')

    htmx.off('htmx:sseBeforeMessage', handle)
  })

  it('raises htmx:sseMessage when message was completely processed', function() {
    var myEventCalled = false

    function handle(evt) {
      myEventCalled = true
    }

    htmx.on('htmx:sseMessage', handle)

    var div = make('<div hx-ext="sse" sse-connect="/event_stream" sse-swap="e1"><div id="d1">div1</div></div>')
    this.clock.tick(1)

    this.eventSource.sendEvent('e1', '<div id="d1">replaced</div>')

    myEventCalled.should.be.true
    byId('d1').innerHTML.should.equal('replaced')

    htmx.off('htmx:sseMessage', handle)
  })

  it('handles sse reconnection', function() {
    this.server.respondWith('GET', '/d1', 'div1 updated')
    this.server.respondWith('GET', '/d2', 'div2 updated')

    var div = make('<div hx-ext="sse" sse-connect="/foo">' +
      '<div id="d1" hx-trigger="sse:e1" hx-get="/d1">div1</div>' +
      '<div id="d2" hx-trigger="sse:e2" hx-get="/d2">div2</div>' +
      '</div>')
    this.clock.tick(1)

    this.eventSource.sendEvent('e1')
    this.server.respond()
    byId('d1').innerHTML.should.equal('div1 updated')
    byId('d2').innerHTML.should.equal('div2')

    var oldEventSource = this.eventSource
    this.eventSource.should.equal(oldEventSource)

    var sseErrorCalled = false
    div.addEventListener("htmx:sseError", function(){
      sseErrorCalled = true
    })

    this.eventSource.simulateConnectionError()
    this.eventSource.readyState.should.equal(EventSource.CLOSED)

    this.clock.tick(500)
    sseErrorCalled.should.equal(true)
    this.eventSource.should.not.equal(oldEventSource)
    this.eventSource.readyState.should.equal(EventSource.CONNECTING)
    this.clock.tick(1)
    this.eventSource.readyState.should.equal(EventSource.OPEN)

    this.eventSource.sendEvent('e2')
    this.server.respond()
    byId('d1').innerHTML.should.equal('div1 updated')
    byId('d2').innerHTML.should.equal('div2 updated')
  })

  it('reconnection retry timeout properly increases over attempts', function() {
    this.server.respondWith('GET', '/d1', 'div1 updated')
    this.server.respondWith('GET', '/d2', 'div2 updated')

    var div = make('<div hx-ext="sse" sse-connect="/foo">' +
      '<div id="d1" hx-trigger="sse:e1" hx-get="/d1">div1</div>' +
      '<div id="d2" hx-trigger="sse:e2" hx-get="/d2">div2</div>' +
      '</div>')
    this.clock.tick(1)

    this.eventSource.sendEvent('e1')
    this.server.respond()
    byId('d1').innerHTML.should.equal('div1 updated')
    byId('d2').innerHTML.should.equal('div2')

    var oldEventSource = this.eventSource
    this.eventSource.should.equal(oldEventSource)

    this.eventSource.simulateConnectionError()
    this.clock.tick(300)
    this.eventSource.should.equal(oldEventSource)
    this.eventSource.readyState.should.equal(EventSource.CLOSED)
    this.clock.tick(200)
    this.eventSource.should.not.equal(oldEventSource)
    this.eventSource.failConnections = true
    this.eventSource.readyState.should.equal(EventSource.CONNECTING)
    this.clock.tick(1)
    this.eventSource.readyState.should.equal(EventSource.CLOSED)

    this.clock.tick(800)
    this.eventSource.readyState.should.equal(EventSource.CLOSED)
    this.clock.tick(200)
    this.eventSource.readyState.should.equal(EventSource.CONNECTING)
    this.eventSource.failConnections = true
    this.clock.tick(1)
    this.eventSource.readyState.should.equal(EventSource.CLOSED)

    this.clock.tick(1950)
    this.eventSource.readyState.should.equal(EventSource.CLOSED)
    this.clock.tick(50)
    this.eventSource.readyState.should.equal(EventSource.CONNECTING)
    this.eventSource.failConnections = true
    this.clock.tick(1)
    this.eventSource.readyState.should.equal(EventSource.CLOSED)

    this.clock.tick(3950)
    this.eventSource.readyState.should.equal(EventSource.CLOSED)
    this.clock.tick(50)
    this.eventSource.readyState.should.equal(EventSource.CONNECTING)
    this.eventSource.failConnections = true
    this.clock.tick(1)
    this.eventSource.readyState.should.equal(EventSource.CLOSED)

    this.clock.tick(7999)
    this.eventSource.readyState.should.equal(EventSource.CLOSED)
    this.clock.tick(1)
    this.eventSource.readyState.should.equal(EventSource.CONNECTING)
    this.eventSource.failConnections = true
    this.clock.tick(1)
    this.eventSource.readyState.should.equal(EventSource.CLOSED)

    this.clock.tick(15999)
    this.eventSource.readyState.should.equal(EventSource.CLOSED)
    this.clock.tick(1)
    this.eventSource.readyState.should.equal(EventSource.CONNECTING)
    this.eventSource.failConnections = true
    this.clock.tick(1)
    this.eventSource.readyState.should.equal(EventSource.CLOSED)

    this.clock.tick(31999)
    this.eventSource.readyState.should.equal(EventSource.CLOSED)
    this.clock.tick(1)
    this.eventSource.readyState.should.equal(EventSource.CONNECTING)
    this.eventSource.failConnections = true
    this.clock.tick(1)
    this.eventSource.readyState.should.equal(EventSource.CLOSED)

    this.clock.tick(63999)
    this.eventSource.readyState.should.equal(EventSource.CLOSED)
    this.clock.tick(1)
    this.eventSource.readyState.should.equal(EventSource.CONNECTING)
    this.eventSource.failConnections = true
    this.clock.tick(1)
    this.eventSource.readyState.should.equal(EventSource.CLOSED)

    // Doesn't go higher than 64s
    this.clock.tick(63999)
    this.eventSource.readyState.should.equal(EventSource.CLOSED)
    this.clock.tick(1)
    this.eventSource.readyState.should.equal(EventSource.CONNECTING)
    this.eventSource.failConnections = true
    this.clock.tick(1)
    this.eventSource.readyState.should.equal(EventSource.CLOSED)

    this.clock.tick(63999)
    this.eventSource.readyState.should.equal(EventSource.CLOSED)
    this.clock.tick(1)
    this.eventSource.readyState.should.equal(EventSource.CONNECTING)
    this.clock.tick(1)
    this.eventSource.readyState.should.equal(EventSource.OPEN)

    this.eventSource.sendEvent('e2')
    this.server.respond()
    byId('d1').innerHTML.should.equal('div1 updated')
    byId('d2').innerHTML.should.equal('div2 updated')
  })

  it('reconnection retry timeout properly resets on successful connection', function() {
    this.server.respondWith('GET', '/d1', 'div1 updated')
    this.server.respondWith('GET', '/d2', 'div2 updated')

    var div = make('<div hx-ext="sse" sse-connect="/foo">' +
      '<div id="d1" hx-trigger="sse:e1" hx-get="/d1">div1</div>' +
      '<div id="d2" hx-trigger="sse:e2" hx-get="/d2">div2</div>' +
      '</div>')
    this.clock.tick(1)

    this.eventSource.sendEvent('e1')
    this.server.respond()
    byId('d1').innerHTML.should.equal('div1 updated')
    byId('d2').innerHTML.should.equal('div2')

    var oldEventSource = this.eventSource
    this.eventSource.should.equal(oldEventSource)

    this.eventSource.simulateConnectionError()
    // Reconnection delays starts at 500ms
    this.clock.tick(300)
    this.eventSource.should.equal(oldEventSource)
    this.eventSource.readyState.should.equal(EventSource.CLOSED)
    this.clock.tick(200)
    this.eventSource.should.not.equal(oldEventSource)
    this.eventSource.readyState.should.equal(EventSource.CONNECTING)
    this.eventSource.failConnections = true
    this.clock.tick(1)
    this.eventSource.readyState.should.equal(EventSource.CLOSED)
    oldEventSource = this.eventSource

    // Delay increases to 1s on the second attempt
    this.clock.tick(800)
    this.eventSource.readyState.should.equal(EventSource.CLOSED)
    this.eventSource.should.equal(oldEventSource)
    this.clock.tick(200)
    this.eventSource.should.not.equal(oldEventSource)
    this.eventSource.readyState.should.equal(EventSource.CONNECTING)
    this.clock.tick(1)
    this.eventSource.readyState.should.equal(EventSource.OPEN)
    oldEventSource = this.eventSource

    // Delay resets to minimum (500ms) after a successful connection
    this.eventSource.simulateConnectionError()
    this.clock.tick(499)
    this.eventSource.should.equal(oldEventSource)
    this.eventSource.readyState.should.equal(EventSource.CLOSED)
    this.clock.tick(1)
    this.eventSource.should.not.equal(oldEventSource)
    this.eventSource.readyState.should.equal(EventSource.CONNECTING)
    this.clock.tick(1)
    this.eventSource.readyState.should.equal(EventSource.OPEN)

    this.eventSource.sendEvent('e2')
    this.server.respond()
    byId('d1').innerHTML.should.equal('div1 updated')
    byId('d2').innerHTML.should.equal('div2 updated')
  })

  // htmx fires htmx:afterProcessNode again whenever an element's attributes change,
  // which is what a morph style swap does, so the extension has to cope with being
  // asked to connect an element that is already connected.
  it('reuses the existing EventSource when the element is processed again', function() {
    var div = make('<div hx-ext="sse" sse-connect="/foo">' +
      '<div id="d1" sse-swap="e1">init</div>' +
      '</div>')
    this.clock.tick(1)

    var first = this.eventSource

    div.setAttribute('data-morphed', 'true')
    htmx.process(div)
    this.clock.tick(1)

    this.eventSources.should.be.lengthOf(1)
    this.eventSource.should.equal(first)
    first.readyState.should.equal(EventSource.OPEN)
    div['htmx-internal-data'].sseEventSource.should.equal(first)
  })

  it('keeps children bound to the reused EventSource', function() {
    var div = make('<div hx-ext="sse" sse-connect="/foo">' +
      '<div id="d1" sse-swap="e1">init</div>' +
      '</div>')
    this.clock.tick(1)

    var first = this.eventSource

    div.setAttribute('data-morphed', 'true')
    htmx.process(div)
    this.clock.tick(1)

    first._listeners.e1.should.be.lengthOf(1)

    this.eventSource.sendEvent('e1', 'Event 1')
    byId('d1').innerHTML.should.equal('Event 1')
  })

  it('does not raise htmx:sseClose when the connection is reused', function() {
    var div = make('<div hx-ext="sse" sse-connect="/foo"></div>')
    this.clock.tick(1)

    var closeCalled = false
    htmx.on(div, 'htmx:sseClose', function() {
      closeCalled = true
    })

    div.setAttribute('data-morphed', 'true')
    htmx.process(div)
    this.clock.tick(1)

    closeCalled.should.equal(false)
  })

  it('replaces the EventSource when sse-connect changes', function() {
    var div = make('<div hx-ext="sse" sse-connect="/foo">' +
      '<div id="d1" sse-swap="e1">init</div>' +
      '</div>')
    this.clock.tick(1)

    var first = this.eventSource
    var test = this
    htmx.on(div, 'htmx:sseClose', function(evt) {
      test.closeType = evt.detail.type
    })

    div.setAttribute('sse-connect', '/bar')
    htmx.process(div)
    this.clock.tick(1)

    first.readyState.should.equal(EventSource.CLOSED)
    this.closeType.should.equal('sourceReplaced')
    this.eventSource.should.not.equal(first)
    this.eventSource.url.should.equal('/bar')
    this.eventSource._listeners.e1.should.be.lengthOf(1)

    this.eventSource.sendEvent('e1', 'Event 1')
    byId('d1').innerHTML.should.equal('Event 1')
  })

  it('does not register duplicate listeners when the element is processed again', function() {
    // the same element owns the connection and is a swap target
    var div = make('<div id="d1" hx-ext="sse" sse-connect="/foo" sse-swap="e1">initial</div>')
    this.clock.tick(1)

    var first = this.eventSource
    var messageCount = 0
    div.addEventListener('htmx:sseMessage', function() {
      messageCount++
    })

    div.setAttribute('data-morphed', 'true')
    htmx.process(div)
    this.clock.tick(1)

    first._listeners.e1.should.be.lengthOf(1)

    this.eventSource.sendEvent('e1', 'Event 1')
    messageCount.should.equal(1)
    byId('d1').innerHTML.should.equal('Event 1')
  })

  it('does not register duplicate listeners when a child is processed again', function() {
    var div = make('<div hx-ext="sse" sse-connect="/foo">' +
      '<div id="d1" sse-swap="e1">initial</div>' +
      '</div>')
    this.clock.tick(1)

    var first = this.eventSource
    var messageCount = 0
    div.addEventListener('htmx:sseMessage', function() {
      messageCount++
    })

    byId('d1').setAttribute('data-morphed', 'true')
    htmx.process(div)
    this.clock.tick(1)

    first._listeners.e1.should.be.lengthOf(1)

    this.eventSource.sendEvent('e1', 'Event 1')
    messageCount.should.equal(1)
    byId('d1').innerHTML.should.equal('Event 1')
  })

  it('does not register duplicate listeners when children are processed again with a new EventSource', function() {
    var div = make('<div hx-ext="sse" sse-connect="/foo">' +
      '<div id="d1" sse-swap="e1">init</div>' +
      '</div>')
    this.clock.tick(1)

    var messageCount = 0
    div.addEventListener('htmx:sseMessage', function() {
      messageCount++
    })

    div.setAttribute('sse-connect', '/bar')
    byId('d1').setAttribute('data-morphed', 'true')
    htmx.process(div)
    this.clock.tick(1)

    this.eventSource._listeners.e1.should.be.lengthOf(1)

    this.eventSource.sendEvent('e1', 'Event 1')
    messageCount.should.equal(1)
  })

  it('closes the EventSource when sse-connect is removed', function() {
    var div = make('<div hx-ext="sse" sse-connect="/foo"></div>')
    this.clock.tick(1)

    var first = this.eventSource
    var test = this
    htmx.on(div, 'htmx:sseClose', function(evt) {
      test.closeType = evt.detail.type
    })

    div.removeAttribute('sse-connect')
    htmx.process(div)
    this.clock.tick(1)

    first.readyState.should.equal(EventSource.CLOSED)
    this.closeType.should.equal('sourceReplaced')
    this.eventSources.should.be.lengthOf(1)
  })

  it('does not open a duplicate EventSource when processed while a reconnect is pending', function() {
    var div = make('<div hx-ext="sse" sse-connect="/foo">' +
      '<div id="d1" sse-swap="e1">init</div>' +
      '</div>')
    this.clock.tick(1)

    this.eventSource.simulateConnectionError()

    div.setAttribute('data-morphed', 'true')
    htmx.process(div)
    this.clock.tick(1)

    // the retry scheduled by the connection error must find the fresh connection
    this.clock.tick(500)

    this.eventSources.should.be.lengthOf(2)
    this.eventSource._listeners.e1.should.be.lengthOf(1)

    this.eventSource.sendEvent('e1', 'Event 1')
    byId('d1').innerHTML.should.equal('Event 1')
  })

  it('opens a new EventSource after the connection was closed', function() {
    var div = make('<div hx-ext="sse" sse-connect="/foo" sse-close="close">' +
      '<div id="d1" sse-swap="e1">init</div>' +
      '</div>')
    this.clock.tick(1)

    var first = this.eventSource
    first.sendEvent('close')
    first.readyState.should.equal(EventSource.CLOSED)

    div.setAttribute('data-morphed', 'true')
    htmx.process(div)
    this.clock.tick(1)

    this.eventSources.should.be.lengthOf(2)
    this.eventSource.should.not.equal(first)
    this.eventSource._listeners.e1.should.be.lengthOf(1)

    this.eventSource.sendEvent('e1', 'Event 1')
    byId('d1').innerHTML.should.equal('Event 1')
  })

  it('does not stack listeners on a nested EventSource when the outer one reconnects', function() {
    make('<div hx-ext="sse" sse-connect="/outer">' +
      '<div sse-connect="/inner">' +
      '<div id="d1" sse-swap="e1">init</div>' +
      '</div>' +
      '</div>')
    this.clock.tick(1)

    var outer = this.eventSources[0]
    var inner = this.eventSources[1]
    inner.url.should.equal('/inner')
    inner._listeners.e1.should.be.lengthOf(1)

    var messageCount = 0
    byId('d1').addEventListener('htmx:sseMessage', function() {
      messageCount++
    })

    // the outer stream drops and reconnects; the nested one never dropped
    outer.simulateConnectionError()
    this.clock.tick(500)
    this.clock.tick(1)

    inner.readyState.should.equal(EventSource.OPEN)
    inner._listeners.e1.should.be.lengthOf(1)

    inner.sendEvent('e1', 'Event 1')
    messageCount.should.equal(1)
    byId('d1').innerHTML.should.equal('Event 1')
  })

  describe('reconnect control', function() {
    it('stops reconnecting when a listener cancels htmx:sseError', function() {
      var div = make('<div hx-ext="sse" sse-connect="/foo"><div id="d1" sse-swap="e1">init</div></div>')
      this.clock.tick(1)
      var closeTypes = []
      div.addEventListener('htmx:sseError', function(evt) { evt.preventDefault() })
      div.addEventListener('htmx:sseClose', function(evt) { closeTypes.push(evt.detail.type) })

      this.eventSource.simulateConnectionError()
      this.clock.tick(200000)

      this.eventSources.should.be.lengthOf(1)
      closeTypes.should.deep.equal(['stopped'])
    })

    it('closes a CONNECTING source when the error is cancelled, ending the browser\'s own reconnect', function() {
      var div = make('<div hx-ext="sse" sse-connect="/foo"></div>')
      this.clock.tick(1)
      div.addEventListener('htmx:sseError', function(evt) { evt.preventDefault() })

      var source = this.eventSource
      source.readyState = EventSource.CONNECTING
      source.onerror()

      source.readyState.should.equal(EventSource.CLOSED)
      this.clock.tick(200000)
      this.eventSources.should.be.lengthOf(1)
    })

    it('describes the failure and counts consecutive attempts', function() {
      var div = make('<div hx-ext="sse" sse-connect="/foo"></div>')
      this.clock.tick(1)
      var seen = []
      div.addEventListener('htmx:sseError', function(evt) {
        seen.push([evt.detail.attempt, evt.detail.failure.kind, evt.detail.failure.status])
      })

      this.eventSource.simulateConnectionError() // attempt 1, retry after 500ms
      this.clock.tick(500)
      this.eventSource.simulateConnectionError() // the retry fails before it opens: attempt 2
      this.clock.tick(1000)
      this.clock.tick(1) // this one opens, which resets the count
      this.eventSource.simulateConnectionError()

      seen.should.deep.equal([[1, 'refused', null], [2, 'refused', null], [1, 'refused', null]])
    })

    it('reports a CONNECTING error as a network failure', function() {
      var div = make('<div hx-ext="sse" sse-connect="/foo"></div>')
      this.clock.tick(1)
      var kind = null
      div.addEventListener('htmx:sseError', function(evt) { kind = evt.detail.failure.kind })

      this.eventSource.readyState = EventSource.CONNECTING
      this.eventSource.onerror()

      kind.should.equal('network')
      this.clock.tick(200000)
      this.eventSources.should.be.lengthOf(1) // the browser reconnects a CONNECTING source by itself
    })

    it('passes on a failure the transport describes itself', function() {
      var div = make('<div hx-ext="sse" sse-connect="/foo"></div>')
      this.clock.tick(1)
      var failure = null
      div.addEventListener('htmx:sseError', function(evt) { failure = evt.detail.failure })

      this.eventSource.close()
      this.eventSource.onerror({ failure: { kind: 'http', status: 401 } })

      failure.should.deep.equal({ kind: 'http', status: 401 })
    })

    it('reconnects now on htmx:sseReconnect, from a descendant, and rebinds the children', function() {
      make('<div hx-ext="sse" sse-connect="/foo"><div id="d1" sse-swap="e1">init</div></div>')
      this.clock.tick(1)
      var first = this.eventSource
      var closeType = null
      first.close = function() { this.readyState = EventSource.CLOSED }
      byId('d1').parentElement.addEventListener('htmx:sseClose', function(evt) { closeType = evt.detail.type })

      htmx.trigger(byId('d1'), 'htmx:sseReconnect')
      this.clock.tick(1)

      first.readyState.should.equal(EventSource.CLOSED)
      closeType.should.equal('reconnect')
      this.eventSources.should.be.lengthOf(2)
      this.eventSource._listeners.e1.should.be.lengthOf(1)
      this.eventSource.sendEvent('e1', 'Event 1')
      byId('d1').innerHTML.should.equal('Event 1')
    })

    it('reopens a stopped connection on htmx:sseReconnect', function() {
      var div = make('<div hx-ext="sse" sse-connect="/foo"></div>')
      this.clock.tick(1)
      var cancel = function(evt) { evt.preventDefault() }
      div.addEventListener('htmx:sseError', cancel)
      this.eventSource.simulateConnectionError()
      div.removeEventListener('htmx:sseError', cancel)

      htmx.trigger(div, 'htmx:sseReconnect')
      this.clock.tick(1)

      this.eventSources.should.be.lengthOf(2)
      this.eventSource.readyState.should.equal(EventSource.OPEN)
    })

    it('does nothing when a listener cancels htmx:sseReconnect', function() {
      var div = make('<div hx-ext="sse" sse-connect="/foo"></div>')
      this.clock.tick(1)
      div.addEventListener('htmx:sseReconnect', function(evt) { evt.preventDefault() })

      htmx.trigger(div, 'htmx:sseReconnect')
      this.clock.tick(1)

      this.eventSources.should.be.lengthOf(1)
      this.eventSource.readyState.should.equal(EventSource.OPEN)
    })

    it('keeps one reconnect chain when a reconnect is requested while one is pending', function() {
      var div = make('<div hx-ext="sse" sse-connect="/foo"></div>')
      this.clock.tick(1)
      htmx.config.sseReconnectDelay = function() { return 5000 }

      this.eventSource.simulateConnectionError() // a retry is now pending for 5s
      htmx.trigger(div, 'htmx:sseReconnect') // opens one right away
      this.clock.tick(1)
      this.eventSource.simulateConnectionError() // which fails too: one new pending retry
      this.clock.tick(20000)

      // initial, the requested reconnect, and ONE retry after it failed. The retry
      // that was pending when the reconnect was requested must not fire as well.
      this.eventSources.should.be.lengthOf(3)
    })

    it('cancels a pending reconnect when the element is cleaned up', function() {
      var div = make('<div hx-ext="sse" sse-connect="/foo"></div>')
      this.clock.tick(1)

      this.eventSource.simulateConnectionError()
      htmx.trigger(div, 'htmx:beforeCleanupElement')
      this.clock.tick(200000)

      this.eventSources.should.be.lengthOf(1)
    })

    it('does not reopen a stream for an element that left the document while it waited', function() {
      var div = make('<div hx-ext="sse" sse-connect="/foo"></div>')
      this.clock.tick(1)

      this.eventSource.simulateConnectionError()
      div.remove()
      this.clock.tick(200000)

      this.eventSources.should.be.lengthOf(1)
    })

    it('uses the delay a sseReconnectDelay function returns, with the attempt and failure', function() {
      var div = make('<div hx-ext="sse" sse-connect="/foo"></div>')
      this.clock.tick(1)
      var args = null
      htmx.config.sseReconnectDelay = function(attempt, failure) {
        args = [attempt, failure.kind]
        return 1234
      }

      this.eventSource.simulateConnectionError()
      this.clock.tick(1233)
      this.eventSources.should.be.lengthOf(1)
      this.clock.tick(1)
      this.eventSources.should.be.lengthOf(2)
      args.should.deep.equal([1, 'refused'])
    })

    it('falls back to the default delay when a sseReconnectDelay function returns no delay', function() {
      make('<div hx-ext="sse" sse-connect="/foo"></div>')
      this.clock.tick(1)
      htmx.config.sseReconnectDelay = function() { return undefined }
      var logged = sinon.stub(console, 'error')

      try {
        this.eventSource.simulateConnectionError()
        this.clock.tick(499)
        this.eventSources.should.be.lengthOf(1)
        this.clock.tick(1)
        this.eventSources.should.be.lengthOf(2)
        logged.called.should.equal(true)
      } finally {
        logged.restore()
      }
    })

    it('spreads a full-jitter delay below the exponential ceiling', function() {
      make('<div hx-ext="sse" sse-connect="/foo"></div>')
      this.clock.tick(1)
      htmx.config.sseReconnectDelay = 'full-jitter'
      var random = sinon.stub(Math, 'random').returns(0.5)

      try {
        this.eventSource.simulateConnectionError() // attempt 1: 0.5 * 500
        this.clock.tick(249)
        this.eventSources.should.be.lengthOf(1)
        this.clock.tick(1)
        this.eventSources.should.be.lengthOf(2)

        // Let the retry open, so the next failure is attempt 1 again, not 2
        this.clock.tick(1)
        this.eventSource.simulateConnectionError()
        this.clock.tick(249)
        this.eventSources.should.be.lengthOf(2)
        this.clock.tick(1)
        this.eventSources.should.be.lengthOf(3)
      } finally {
        random.restore()
      }
    })

    it('grows the full-jitter ceiling with consecutive failures', function() {
      make('<div hx-ext="sse" sse-connect="/foo"></div>')
      this.clock.tick(1)
      htmx.config.sseReconnectDelay = 'full-jitter'
      var delays = []
      var random = sinon.stub(Math, 'random').returns(0.5)
      var test = this
      // every retry fails before it can open
      var create = htmx.createEventSource
      htmx.createEventSource = function(url) {
        var es = create(url)
        es.failConnections = true
        return es
      }

      try {
        this.eventSource.simulateConnectionError()
        for (var i = 0; i < 9; i++) {
          var before = test.eventSources.length
          var waited = 0
          while (test.eventSources.length === before) {
            test.clock.tick(1)
            waited++
          }
          delays.push(waited)
        }
        // 0.5 * 500 * 2^(attempt-1), capped at attempt 8 (64s ceiling). Every wait
        // after the first also includes the 1ms the mock takes to fail a connect.
        delays.should.deep.equal([250, 501, 1001, 2001, 4001, 8001, 16001, 32001, 32001])
      } finally {
        random.restore()
      }
    })
  })
})
