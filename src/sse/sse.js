/*
Server Sent Events Extension
============================
This extension adds support for Server Sent Events to htmx.  See /www/extensions/sse.md for usage instructions.

*/

(function() {
  /** @type {import("../htmx").HtmxInternalApi} */
  var api

  /**
   * sseSources keeps a reference to the EventSource that was created for an element,
   * together with the attribute values it was created from.
   *
   * htmx fires htmx:afterProcessNode again every time an element's attributes change,
   * and it wipes that element's internal data right before doing so. Without this map
   * the extension has no reference left to the connection it opened earlier, so it
   * would open a second one and leave the first one open forever.
   *
   * @type {WeakMap<HTMLElement, {source: EventSource, url: string, closeAttribute: string}>}
   */
  var sseSources = new WeakMap()

  /**
   * sseListeners keeps the listeners that were registered for an element, so that they
   * can be removed before the element is registered again.
   *
   * This is needed for the same reason as sseSources: htmx wipes an element's internal
   * data before it re-fires htmx:afterProcessNode, so sseEventListener no longer refers
   * to what was registered earlier, and the element would end up listening twice.
   *
   * @type {WeakMap<HTMLElement, Array<{source: EventSource, name: string, listener: Function}>>}
   */
  var sseListeners = new WeakMap()

  /**
   * sseStates keeps the reconnect state of every element that owns a connection:
   *
   * - timer: the pending reconnect, so that it can be cancelled. An untracked timer
   *   survives a reconnect requested in the meantime, and whichever of the two
   *   finds a CLOSED source when it fires opens a second one; it also survives the
   *   element being cleaned up, and opens a stream for a detached element.
   * - attempt: consecutive failed attempts since the last successful open. This is
   *   what a reconnect delay function receives.
   * - backoff: the multiplier of the default 'exponential' delay (1, 2, 4 ... 128).
   *   Kept apart from attempt because it is not a count.
   * - hadSource: a source was created for this element before, so descendants are
   *   listening on an old one and must be registered again when the new one opens.
   *
   * Like sseSources, it lives outside the element's internal data because htmx
   * wipes that data every time it processes the element again.
   *
   * @type {WeakMap<HTMLElement, {timer: number|null, attempt: number, backoff: number, hadSource: boolean}>}
   */
  var sseStates = new WeakMap()

  htmx.defineExtension('sse', {

    /**
     * Init saves the provided reference to the internal HTMX API.
     *
     * @param {import("../htmx").HtmxInternalApi} api
     * @returns void
     */
    init: function(apiRef) {
      // store a reference to the internal API.
      api = apiRef

      // set a function in the public API for creating new EventSource objects
      if (htmx.createEventSource == undefined) {
        htmx.createEventSource = createEventSource
      }

      // Default reconnect delay. 'exponential' is the delay this extension has always
      // used, so nothing changes unless a page asks for something else.
      if (!htmx.config.sseReconnectDelay) {
        htmx.config.sseReconnectDelay = 'exponential'
      }

      // Default transport: the browser's own EventSource. 'fetch' selects
      // FetchEventSource, which is also exposed for a page's own createEventSource.
      if (!htmx.config.sseTransport) {
        htmx.config.sseTransport = 'eventsource'
      }
      htmx.FetchEventSource = FetchEventSource
    },

    getSelectors: function() {
      return ['[sse-connect]', '[data-sse-connect]', '[sse-swap]', '[data-sse-swap]']
    },

    /**
     * onEvent handles all events passed to this extension.
     *
     * @param {string} name
     * @param {Event} evt
     * @returns void
     */
    onEvent: function(name, evt) {
      var parent = evt.target || evt.detail.elt
      switch (name) {
        case 'htmx:beforeCleanupElement':
          // Try to remove remove an EventSource when elements are removed
          closeEventSource(parent, 'nodeReplaced')

          return

        // Try to create EventSources when elements are processed
        case 'htmx:afterProcessNode':
          ensureEventSourceOnElement(parent)
          return

        // Reconnect now, on request. Triggered on the element that owns the
        // connection or on any of its descendants. A listener can cancel it, in which
        // case htmx does not call this at all.
        case 'htmx:sseReconnect':
          reconnect(parent)
      }
    }
  })

  /// ////////////////////////////////////////////
  // HELPER FUNCTIONS
  /// ////////////////////////////////////////////

  /**
   * createEventSource is the default method for creating new EventSource objects.
   * It is installed as htmx.createEventSource, which a page can replace with its own
   * function before or after this extension is loaded.
   *
   * htmx.config.sseTransport picks the implementation: 'eventsource' (the default) is
   * the browser's EventSource, 'fetch' is FetchEventSource.
   *
   * @param {string} url
   * @returns EventSource
   */
  function createEventSource(url) {
    if (htmx.config.sseTransport === 'fetch') {
      return new FetchEventSource(url, { withCredentials: true })
    }
    if (htmx.config.sseTransport !== 'eventsource') {
      logError('htmx.config.sseTransport must be "eventsource" or "fetch"; using "eventsource"')
    }
    return new EventSource(url, { withCredentials: true })
  }

  /**
   * registerSSE looks for attributes that can contain sse events, right
   * now hx-trigger and sse-swap and adds listeners based on these attributes too
   * the closest event source
   *
   * @param {HTMLElement} elt
   */
  function registerSSE(elt) {
    // Drop what this element registered earlier, so that processing it again does not
    // leave it listening for the same event twice
    removeSSEListeners(elt)

    // Add message handlers for every `sse-swap` attribute
    if (api.getAttributeValue(elt, 'sse-swap')) {
      // Find closest existing event source
      var sourceElement = api.getClosestMatch(elt, hasEventSource)
      if (sourceElement == null) {
        // api.triggerErrorEvent(elt, "htmx:noSSESourceError")
        return null // no eventsource in parentage, orphaned element
      }

      // Set internalData and source
      var internalData = api.getInternalData(sourceElement)
      var source = internalData.sseEventSource

      var sseSwapAttr = api.getAttributeValue(elt, 'sse-swap')
      var sseEventNames = sseSwapAttr.split(',')

      for (var i = 0; i < sseEventNames.length; i++) {
        const sseEventName = sseEventNames[i].trim()
        const listener = function(event) {
          // If the source is missing then close SSE
          if (maybeCloseSSESource(sourceElement)) {
            return
          }

          // If the body no longer contains the element, remove the listener
          if (!api.bodyContains(elt)) {
            source.removeEventListener(sseEventName, listener)
            return
          }

          // swap the response into the DOM and trigger a notification
          if (!api.triggerEvent(elt, 'htmx:sseBeforeMessage', event)) {
            return
          }
          swap(elt, event.data)
          api.triggerEvent(elt, 'htmx:sseMessage', event)
        }

        // Register the new listener
        api.getInternalData(elt).sseEventListener = listener
        addSSEListener(elt, source, sseEventName, listener)
      }
    }

    // Add message handlers for every `hx-trigger="sse:*"` attribute
    if (api.getAttributeValue(elt, 'hx-trigger')) {
      // Find closest existing event source
      var sourceElement = api.getClosestMatch(elt, hasEventSource)
      if (sourceElement == null) {
        // api.triggerErrorEvent(elt, "htmx:noSSESourceError")
        return null // no eventsource in parentage, orphaned element
      }

      // Set internalData and source
      var internalData = api.getInternalData(sourceElement)
      var source = internalData.sseEventSource

      var triggerSpecs = api.getTriggerSpecs(elt)
      triggerSpecs.forEach(function(ts) {
        if (ts.trigger.slice(0, 4) !== 'sse:') {
          return
        }

        var listener = function (event) {
          if (maybeCloseSSESource(sourceElement)) {
            return
          }
          if (!api.bodyContains(elt)) {
            source.removeEventListener(ts.trigger.slice(4), listener)
          }
          // Trigger events to be handled by the rest of htmx
          htmx.trigger(elt, ts.trigger, event)
          htmx.trigger(elt, 'htmx:sseMessage', event)
        }

        // Register the new listener
        api.getInternalData(elt).sseEventListener = listener
        addSSEListener(elt, source, ts.trigger.slice(4), listener)
      })
    }
  }

  /**
   * ensureEventSourceOnElement creates a new EventSource connection on the provided element.
   * If a usable EventSource already exists, then it is returned.  If not, then a new EventSource
   * is created and stored in the element's internalData.
   * @param {HTMLElement} elt
   * @returns {EventSource | null}
   */
  function ensureEventSourceOnElement(elt) {
    if (elt == null) {
      return null
    }

    // handle extension source creation attribute
    var sseURL = api.getAttributeValue(elt, 'sse-connect')
    if (sseURL) {
      ensureEventSource(elt, sseURL)
    } else {
      // the element does not ask for a connection anymore, close the one it owned
      closeEventSource(elt, 'sourceReplaced')
    }

    registerSSE(elt)
  }

  /**
   * ensureEventSource connects the given element to the given url.
   *
   * If the element already is connected to that url and the connection is still
   * usable, then the existing EventSource is kept, and its reference is restored in
   * the element's internal data, which htmx wipes every time it processes the element.
   *
   * @param {HTMLElement} elt
   * @param {string} url
   */
  function ensureEventSource(elt, url) {
    var closeAttribute = api.getAttributeValue(elt, 'sse-close')
    var previous = sseSources.get(elt)
    var state = getState(elt)

    if (previous) {
      if (previous.source.readyState !== EventSource.CLOSED) {
        if (previous.url === url && previous.closeAttribute === closeAttribute) {
          // Already connected, keep the stream instead of opening a second one
          api.getInternalData(elt).sseEventSource = previous.source
          return
        }

        // The element asks for a different connection now, close the previous one
        closeEventSource(elt, 'sourceReplaced')
      }
    }

    // A fresh source makes a reconnect that is still pending pointless. Left alone it
    // would only find this source in use and return, since a failure of this source
    // schedules its own reconnect and replaces the pending one; clearing it is tidiness.
    clearReconnect(state)

    // Descendants are still listening on the source that is being replaced
    var replacedSource = state.hadSource
    state.hadSource = true

    var source = (htmx.createEventSource || createEventSource)(url)

    source.onerror = function(err) {
      state.attempt++
      var failure = describeFailure(source, err)

      // Log an error event. A listener can cancel it to stop reconnecting.
      var proceed = api.triggerEvent(elt, 'htmx:sseError', {
        error: err,
        source,
        failure,
        attempt: state.attempt
      })

      // If parent no longer exists in the document, then clean up this EventSource
      if (maybeCloseSSESource(elt)) {
        return
      }

      if (!proceed) {
        // Stopped until the element is processed again or htmx:sseReconnect is
        // triggered. A source that is CONNECTING is closed too, which ends the
        // reconnecting the browser does by itself after a network error.
        closeEventSource(elt, 'stopped')
        return
      }

      // Otherwise, try to reconnect the EventSource. A source that is CONNECTING is
      // being reconnected by the browser itself, which the specification requires
      // after a network error; only a CLOSED one is ours to reopen.
      if (source.readyState === EventSource.CLOSED) {
        scheduleReconnect(elt, state, failure)
      }
    }

    source.onopen = function(evt) {
      // We want to increase the reconnection delay for consecutive failed attempts only
      state.attempt = 0
      state.backoff = 0

      api.triggerEvent(elt, 'htmx:sseOpen', { source })

      if (replacedSource) {
        const childrenToFix = elt.querySelectorAll("[sse-swap], [data-sse-swap], [hx-trigger], [data-hx-trigger]")
        for (let i = 0; i < childrenToFix.length; i++) {
          registerSSE(childrenToFix[i])
        }
        replacedSource = false
      }
    }

    api.getInternalData(elt).sseEventSource = source
    sseSources.set(elt, { source, url, closeAttribute })

    if (closeAttribute) {
      // close eventsource when this message is received
      source.addEventListener(closeAttribute, function() {
        api.triggerEvent(elt, 'htmx:sseClose', {
          source,
          type: 'message',
        })
        source.close()
      });
    }
  }

  /**
   * maybeCloseSSESource confirms that the parent element still exists.
   * If not, then any associated SSE source is closed and the function returns true.
   *
   * @param {HTMLElement} elt
   * @returns boolean
   */
  function maybeCloseSSESource(elt) {
    if (!api.bodyContains(elt)) {
      return closeEventSource(elt, 'nodeMissing')
    }
    return false
  }

  /**
   * addSSEListener starts listening for an event on the given source, and keeps track
   * of the listener so that it can be removed again.
   *
   * @param {HTMLElement} elt
   * @param {EventSource} source
   * @param {string} name
   * @param {Function} listener
   */
  function addSSEListener(elt, source, name, listener) {
    var listeners = sseListeners.get(elt)
    if (!listeners) {
      listeners = []
      sseListeners.set(elt, listeners)
    }

    listeners.push({ source, name, listener })
    source.addEventListener(name, listener)
  }

  /**
   * removeSSEListeners stops listening for every event this element was registered for.
   *
   * @param {HTMLElement} elt
   */
  function removeSSEListeners(elt) {
    var listeners = sseListeners.get(elt)
    if (!listeners) {
      return
    }

    for (var i = 0; i < listeners.length; i++) {
      listeners[i].source.removeEventListener(listeners[i].name, listeners[i].listener)
    }
    sseListeners.delete(elt)
  }

  /**
   * closeEventSource closes the EventSource that was created for the given element,
   * if there still is one, and reports the reason it was closed.
   *
   * The source is looked up in sseSources as well, because htmx wipes an element's
   * internal data whenever it processes that element again.
   *
   * @param {HTMLElement} elt
   * @param {string} type
   * @returns boolean whether a source was closed
   */
  function closeEventSource(elt, type) {
    // A reconnect that is still pending belongs to the source being closed
    var state = sseStates.get(elt)
    if (state) {
      clearReconnect(state)
    }

    var internalData = api.getInternalData(elt)
    var tracked = sseSources.get(elt)
    var source = internalData.sseEventSource || (tracked && tracked.source)
    if (!source) {
      return false
    }

    api.triggerEvent(elt, 'htmx:sseClose', {
      source,
      type,
    })
    source.close()
    sseSources.delete(elt)
    delete internalData.sseEventSource
    return true
  }


  /**
   * @param {HTMLElement} elt
   * @param {string} content
   */
  function swap(elt, content) {
    api.withExtensions(elt, function(extension) {
      content = extension.transformResponse(content, null, elt)
    })

    var swapSpec = api.getSwapSpecification(elt)
    var target = api.getTarget(elt)
    api.swap(target, content, swapSpec, { contextElement: elt })
  }


  function hasEventSource(node) {
    return api.getInternalData(node).sseEventSource != null
  }

  /**
   * @param {HTMLElement} elt
   */
  function getState(elt) {
    var state = sseStates.get(elt)
    if (!state) {
      state = { timer: null, attempt: 0, backoff: 0, hadSource: false }
      sseStates.set(elt, state)
    }
    return state
  }

  function clearReconnect(state) {
    if (state.timer !== null) {
      window.clearTimeout(state.timer)
      state.timer = null
    }
  }

  /**
   * describeFailure says why a connection failed, as far as the source can tell.
   *
   * A native EventSource tells nothing: the specification hands the error event no
   * status and no headers. What its readyState still tells apart is the two cases
   * the specification treats differently: CLOSED means the server answered with
   * something other than a 200 text/event-stream response (it "failed the
   * connection"), CONNECTING means the connection was lost and the browser is
   * reconnecting by itself. A transport that knows more puts its own description on
   * the error event as `failure`, which is then passed on as it is.
   *
   * @param {EventSource} source
   * @param {any} err
   * @returns {{kind: string, status: number|null}}
   */
  function describeFailure(source, err) {
    if (err && typeof err === 'object' && err.failure) {
      return err.failure
    }
    if (source.readyState === EventSource.CLOSED) {
      return { kind: 'refused', status: null }
    }
    return { kind: 'network', status: null }
  }

  /**
   * reconnect opens a new connection for the element that owns the connection of
   * the given element, now, starting the delays over. It works the same whether the
   * connection is open, waiting for a reconnect, or stopped.
   *
   * @param {HTMLElement} elt
   */
  function reconnect(elt) {
    var owner = api.getClosestMatch(elt, function(node) {
      return !!api.getAttributeValue(node, 'sse-connect')
    })
    if (!owner) {
      return
    }

    var state = getState(owner)
    state.attempt = 0
    state.backoff = 0
    closeEventSource(owner, 'reconnect')
    ensureEventSourceOnElement(owner)
  }

  /**
   * scheduleReconnect reopens the element's connection after the delay chosen by
   * htmx.config.sseReconnectDelay.
   *
   * @param {HTMLElement} elt
   * @param {object} state
   * @param {{kind: string, status: number|null}} failure
   */
  function scheduleReconnect(elt, state, failure) {
    clearReconnect(state)
    state.timer = window.setTimeout(function() {
      state.timer = null
      if (!api.bodyContains(elt)) {
        closeEventSource(elt, 'nodeMissing')
        return
      }
      ensureEventSourceOnElement(elt)
    }, getReconnectDelay(state, failure))
  }

  /**
   * getReconnectDelay returns the delay before the next attempt, in milliseconds.
   *
   * htmx.config.sseReconnectDelay is one of:
   *
   * - 'exponential' (the default): 500ms, doubling up to 64s, the same for everyone.
   * - 'full-jitter': a random delay between 0 and that same exponential ceiling, so
   *   that clients that lost the connection at the same moment do not all come back
   *   at the same moment.
   * - a function(attempt, failure) returning the delay in milliseconds, where attempt
   *   is the number of consecutive failed attempts (1 for the first) and failure is
   *   what is known about the last one (see htmx:sseError).
   *
   * @param {object} state
   * @param {{kind: string, status: number|null}} failure
   * @returns {number}
   */
  function getReconnectDelay(state, failure) {
    var delay = htmx.config.sseReconnectDelay
    if (typeof delay === 'function') {
      var ms = delay(state.attempt, failure)
      if (typeof ms === 'number' && ms >= 0) {
        return ms
      }
      logError('htmx.config.sseReconnectDelay returned ' + ms + ', which is not a delay; using the default')
    } else if (delay === 'full-jitter') {
      return Math.random() * 500 * Math.pow(2, Math.min(state.attempt - 1, 7))
    } else if (delay !== 'exponential' && delay != null) {
      logError('htmx.config.sseReconnectDelay must be "exponential", "full-jitter" or a function; using the default')
    }

    state.backoff = Math.max(Math.min(state.backoff * 2, 128), 1)
    return state.backoff * 500
  }

  function logError(msg) {
    if (console.error) {
      console.error(msg)
    }
  }

  /// ////////////////////////////////////////////
  // FETCH TRANSPORT
  /// ////////////////////////////////////////////

  var CONNECTING = 0
  var OPEN = 1
  var CLOSED = 2

  // How long to wait for the browser to report it is online again before trying
  // anyway: navigator.onLine is not reliable everywhere, in-app browsers especially.
  var OFFLINE_WAIT_CAP = 60000

  /**
   * FetchEventSource is an EventSource that reads the stream with fetch().
   *
   * It follows the processing model of the EventSource specification
   * (https://html.spec.whatwg.org/multipage/server-sent-events.html) and has the
   * same interface, with one addition: every `error` event carries a `failure`
   * property that says why the connection failed.
   *
   * - {kind: 'http', status, headers, url, redirected}: the server answered with a
   *   status other than 200. Like EventSource, the connection is failed: readyState
   *   becomes CLOSED and nothing reconnects it.
   * - {kind: 'content-type', status, headers, url, redirected}: a 200 response that
   *   is not text/event-stream, for example an HTML page served in its place. Failed
   *   like the above.
   * - {kind: 'network', status: null}: the request or the stream failed without a
   *   response. Like EventSource, readyState becomes CONNECTING and the connection is
   *   reestablished after the reconnection time (3s, or what the stream set with a
   *   `retry:` field).
   * - {kind: 'ended', status: null}: the server ended the stream. Reestablished like
   *   a network failure, as the specification requires.
   *
   * This is the only thing EventSource cannot do: the specification hands its error
   * event no status and no headers, so a page cannot tell an expired session from a
   * proxy's challenge page from a server that is restarting. Cross-origin, only the
   * headers the server exposes through CORS are readable, as with any fetch().
   *
   * Differences that are not about failures:
   *
   * - The stream is closed on pagehide and reopened on a pageshow that restores the
   *   page from the back/forward cache, without an error event in between. An open
   *   fetch() keeps a page out of that cache in some browsers, where an EventSource
   *   does not.
   * - While navigator.onLine is false, a reconnect waits for the `online` event, for
   *   at most 60s.
   *
   * Needs fetch() with a readable body, AbortController and a constructible
   * EventTarget: Chrome 64, Firefox 65, Safari 14.
   *
   * @param {string} url
   * @param {{withCredentials?: boolean}} [options]
   */
  function FetchEventSource(url, options) {
    var self = this
    var target = new EventTarget()
    var controller = null
    var reconnectTimer = null
    var onlineListener = null
    var suspended = false
    var reconnectionTime = 3000
    var lastEventId = ''
    var origin = ''

    try {
      this.url = new URL(url, document.baseURI).href
    } catch (e) {
      throw new DOMException('Invalid URL: ' + url, 'SyntaxError')
    }
    this.withCredentials = !!(options && options.withCredentials)
    this.readyState = CONNECTING
    this.onopen = null
    this.onmessage = null
    this.onerror = null

    this.addEventListener = function(type, listener, opts) {
      target.addEventListener(type, listener, opts)
    }
    this.removeEventListener = function(type, listener, opts) {
      target.removeEventListener(type, listener, opts)
    }
    this.dispatchEvent = function(event) {
      var handler = self['on' + event.type]
      if (typeof handler === 'function') {
        try {
          handler.call(self, event)
        } catch (e) {
          reportError(e)
        }
      }
      return target.dispatchEvent(event)
    }

    this.close = function() {
      self.readyState = CLOSED
      stopWaiting()
      abortFetch()
      window.removeEventListener('pagehide', onPageHide)
      window.removeEventListener('pageshow', onPageShow)
    }

    window.addEventListener('pagehide', onPageHide)
    window.addEventListener('pageshow', onPageShow)
    connect()

    function connect() {
      stopWaiting()
      controller = new AbortController()
      var signal = controller.signal
      var headers = { Accept: 'text/event-stream' }
      if (lastEventId !== '') {
        headers['Last-Event-ID'] = lastEventId
      }

      fetch(self.url, {
        headers: headers,
        cache: 'no-store',
        credentials: self.withCredentials ? 'include' : 'same-origin',
        mode: 'cors',
        redirect: 'follow',
        signal: signal
      }).then(function(response) {
        if (signal.aborted) {
          cancelBody(response)
          return
        }
        if (response.status !== 200 || !isEventStream(response.headers.get('Content-Type'))) {
          cancelBody(response)
          failConnection({
            kind: response.status !== 200 ? 'http' : 'content-type',
            status: response.status,
            headers: response.headers,
            url: response.url,
            redirected: response.redirected
          })
          return
        }
        if (!response.body) {
          reestablish({ kind: 'network', status: null })
          return
        }
        origin = originOf(response.url || self.url)
        self.readyState = OPEN
        self.dispatchEvent(new Event('open'))
        return read(response.body.getReader(), signal)
      }, function() {
        if (!signal.aborted) {
          reestablish({ kind: 'network', status: null })
        }
      })
    }

    function read(reader, signal) {
      var decoder = new TextDecoder('utf-8')
      var parser = createParser(function(type, data, id) {
        lastEventId = id
        if (type === null || self.readyState === CLOSED || signal.aborted) {
          return
        }
        self.dispatchEvent(new MessageEvent(type, { data: data, origin: origin, lastEventId: lastEventId }))
      }, function(ms) {
        reconnectionTime = ms
      }, function() {
        return self.readyState === CLOSED || signal.aborted
      })

      function pump() {
        return reader.read().then(function(result) {
          if (signal.aborted) {
            return
          }
          if (result.done) {
            parser.end()
            reestablish({ kind: 'ended', status: null })
            return
          }
          parser.feed(decoder.decode(result.value, { stream: true }))
          if (self.readyState === CLOSED || signal.aborted) {
            reader.cancel().catch(function() {})
            return
          }
          return pump()
        }, function() {
          if (!signal.aborted) {
            reestablish({ kind: 'network', status: null })
          }
        })
      }
      return pump()
    }

    // "Fail the connection": CLOSED first, then the error event, and nothing reconnects.
    function failConnection(failure) {
      if (self.readyState === CLOSED) {
        return
      }
      self.readyState = CLOSED
      abortFetch()
      fireError(failure)
    }

    // "Reestablish the connection": CONNECTING first, then the error event, then wait
    // the reconnection time and connect again, unless the connection was closed in
    // the meantime.
    function reestablish(failure) {
      if (self.readyState === CLOSED) {
        return
      }
      abortFetch()
      self.readyState = CONNECTING
      fireError(failure)
      if (self.readyState !== CONNECTING) {
        return
      }
      stopWaiting()
      if (navigator.onLine === false) {
        onlineListener = function() {
          stopWaiting()
          reconnectTimer = window.setTimeout(retry, reconnectionTime)
        }
        window.addEventListener('online', onlineListener)
        reconnectTimer = window.setTimeout(retry, Math.max(reconnectionTime, OFFLINE_WAIT_CAP))
      } else {
        reconnectTimer = window.setTimeout(retry, reconnectionTime)
      }
    }

    function retry() {
      reconnectTimer = null
      if (self.readyState === CONNECTING && !suspended) {
        connect()
      }
    }

    function fireError(failure) {
      var event = new Event('error')
      event.failure = failure
      self.dispatchEvent(event)
    }

    function stopWaiting() {
      if (reconnectTimer !== null) {
        window.clearTimeout(reconnectTimer)
        reconnectTimer = null
      }
      if (onlineListener !== null) {
        window.removeEventListener('online', onlineListener)
        onlineListener = null
      }
    }

    function abortFetch() {
      if (controller !== null) {
        controller.abort()
        controller = null
      }
    }

    function onPageHide() {
      if (self.readyState === CLOSED) {
        return
      }
      suspended = true
      stopWaiting()
      abortFetch()
      self.readyState = CONNECTING
    }

    function onPageShow(event) {
      if (!suspended || self.readyState === CLOSED) {
        return
      }
      if (event.persisted) {
        suspended = false
        connect()
      }
    }
  }

  FetchEventSource.CONNECTING = FetchEventSource.prototype.CONNECTING = CONNECTING
  FetchEventSource.OPEN = FetchEventSource.prototype.OPEN = OPEN
  FetchEventSource.CLOSED = FetchEventSource.prototype.CLOSED = CLOSED

  /**
   * createParser returns an event stream parser, as specified in "Interpreting an
   * event stream". Text is fed as it is decoded; a line ending may be split across
   * two chunks (CR at the end of one, LF at the start of the next).
   *
   * onEvent(type, data, id) is called at every empty line: type is null when there is
   * nothing to dispatch (empty data), and id is the last event ID buffer, which the
   * source's last event ID is set to either way. The buffer belongs to the stream:
   * it starts empty on every connection and is not reset between events.
   *
   * isStopped() is asked after every line, so that a listener closing the source
   * stops the rest of the chunk from being dispatched.
   *
   * @param {function(string|null, string, string|null)} onEvent
   * @param {function(number)} onRetry
   * @param {function(): boolean} isStopped
   */
  function createParser(onEvent, onRetry, isStopped) {
    var line = ''
    var pendingCR = false
    var data = ''
    var eventType = ''
    var idBuffer = ''

    function feed(text) {
      var pos = 0
      if (pendingCR && text.charAt(0) === '\n') {
        pos = 1
      }
      pendingCR = false
      while (pos < text.length) {
        var cr = text.indexOf('\r', pos)
        var lf = text.indexOf('\n', pos)
        var end = cr === -1 ? lf : (lf === -1 ? cr : Math.min(cr, lf))
        if (end === -1) {
          line += text.slice(pos)
          return
        }
        line += text.slice(pos, end)
        processLine(line)
        line = ''
        if (text.charAt(end) === '\r') {
          if (end + 1 === text.length) {
            pendingCR = true
          } else if (text.charAt(end + 1) === '\n') {
            end++
          }
        }
        pos = end + 1
        if (isStopped()) {
          return
        }
      }
    }

    function processLine(l) {
      if (l === '') {
        dispatch()
        return
      }
      if (l.charAt(0) === ':') {
        return
      }
      var colon = l.indexOf(':')
      var field = l
      var value = ''
      if (colon !== -1) {
        field = l.slice(0, colon)
        value = l.slice(colon + 1)
        if (value.charAt(0) === ' ') {
          value = value.slice(1)
        }
      }
      if (field === 'event') {
        eventType = value
      } else if (field === 'data') {
        data += value + '\n'
      } else if (field === 'id') {
        if (value.indexOf('\u0000') === -1) {
          idBuffer = value
        }
      } else if (field === 'retry') {
        if (/^[0-9]+$/.test(value)) {
          onRetry(parseInt(value, 10))
        }
      }
    }

    function dispatch() {
      if (data === '') {
        eventType = ''
        onEvent(null, '', idBuffer)
        return
      }
      var d = data.charAt(data.length - 1) === '\n' ? data.slice(0, -1) : data
      var type = eventType === '' ? 'message' : eventType
      data = ''
      eventType = ''
      onEvent(type, d, idBuffer)
    }

    // End of the stream: an event that did not end with an empty line is discarded.
    function end() {
      line = ''
      pendingCR = false
      data = ''
      eventType = ''
    }

    return { feed: feed, end: end }
  }

  /**
   * isEventStream checks that a Content-Type header's MIME type essence is
   * text/event-stream, ignoring case and parameters such as charset.
   *
   * @param {string|null} contentType
   */
  function isEventStream(contentType) {
    if (!contentType) {
      return false
    }
    return contentType.split(';')[0].trim().toLowerCase() === 'text/event-stream'
  }

  function cancelBody(response) {
    if (response.body) {
      response.body.cancel().catch(function() {})
    }
  }

  function originOf(url) {
    try {
      return new URL(url).origin
    } catch (e) {
      return ''
    }
  }

  function reportError(e) {
    if (typeof window.reportError === 'function') {
      window.reportError(e)
    } else {
      window.setTimeout(function() { throw e })
    }
  }
})()
