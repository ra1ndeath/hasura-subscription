import Backoff from 'backo2';
import EventEmitter from 'eventemitter3';
import $$observable from 'symbol-observable';
const isString = (value) => typeof value === 'string';
const isObject = (value) => value !== null && typeof value === 'object';
export class SubscriptionClient {
  constructor(url, options, protocols = 'graphql-ws') {
    const { connectionCallback = undefined, connectionParams = {}, minTimeout = 1000, timeout = 30000, reconnect = false, reconnectionAttempts = Infinity, inactivityTimeout = 0 } = options || {};
    this.webSocket = WebSocket;
    this.url = url;
    this.operations = {};
    this.nextOperationId = 0;
    this.wsMinTimeout = minTimeout;
    this.wsTimeout = timeout;
    this.unsentMessagesQueue = [];
    this.reconnect = reconnect;
    this.reconnecting = false;
    this.reconnectionAttempts = reconnectionAttempts;
    this.inactivityTimeout = inactivityTimeout;
    this.closedByUser = false;
    this.backoff = new Backoff({ jitter: 0.5 });
    this.eventEmitter = new EventEmitter();
    this.client = null;
    this.connectionCallback = connectionCallback;
    this.maxConnectTimeGenerator = this.createMaxConnectTimeGenerator();
    this.connectionParams = this.getConnectionParams(connectionParams);
  }
  get status() {
    if (this.client === null) {
      return this.webSocket.CLOSED;
    }
    return this.client.readyState;
  }
  close(isForced = true, closedByUser = true) {
    this.clearInactivityTimeout();
    if (this.client !== null) {
      this.closedByUser = closedByUser;
      if (isForced) {
        this.clearCheckConnectionInterval();
        this.clearMaxConnectTimeout();
        this.clearTryReconnectTimeout();
        this.unsubscribeAll();
        this.sendMessage(undefined, 'connection_terminate', null);
      }
      this.client.close();
      this.client = null;
      this.eventEmitter.emit('disconnected');
      if (!isForced) {
        this.tryReconnect();
      }
    }
  }
  request(request) {
    const getObserver = this.getObserver.bind(this);
    const executeOperation = this.executeOperation.bind(this);
    const unsubscribe = this.unsubscribe.bind(this);
    let opId;
    this.clearInactivityTimeout();
    return {
      [$$observable]() {
        return this;
      },
      subscribe(observerOrNext, onError, onComplete) {
        const observer = getObserver(observerOrNext, onError, onComplete);
        opId = executeOperation(request, (error, result) => {
          if (error === null && result === null) {
            if (observer.complete) {
              observer.complete();
            }
          }
          else if (error) {
            if (observer.error) {
              observer.error(error[0]);
            }
          }
          else {
            if (observer.next) {
              observer.next(result);
            }
          }
        });
        return {
          unsubscribe: () => {
            if (opId) {
              unsubscribe(opId);
              opId = null;
            }
          }
        };
      }
    };
  }
  on(eventName, callback, context) {
    const handler = this.eventEmitter.on(eventName, callback, context);
    return () => {
      handler.off(eventName, callback, context);
    };
  }
  onConnected(callback, context) {
    return this.on('connected', callback, context);
  }
  onConnecting(callback, context) {
    return this.on('connecting', callback, context);
  }
  onDisconnected(callback, context) {
    return this.on('disconnected', callback, context);
  }
  onReconnected(callback, context) {
    return this.on('reconnected', callback, context);
  }
  onReconnecting(callback, context) {
    return this.on('reconnecting', callback, context);
  }
  onError(callback, context) {
    return this.on('error', callback, context);
  }
  unsubscribeAll() {
    Object.keys(this.operations).forEach(subId => {
      this.unsubscribe(subId);
    });
  }
  getConnectionParams(connectionParams) {
    return () => {
      return new Promise((resolve, reject) => {
        if (typeof connectionParams === 'function') {
          try {
            return resolve(connectionParams());
          }
          catch (error) {
            return reject(error);
          }
        }
        resolve(connectionParams);
      });
    };
  }
  executeOperation(options, handler) {
    if (this.client === null) {
      this.connect();
    }
    const opId = this.generateOperationId();
    this.operations[opId] = { options: options, handler };
    try {
      this.checkOperationOptions(options, handler);
      if (this.operations[opId]) {
        this.operations[opId] = { options, handler };
        this.sendMessage(opId, 'start', options);
      }
    }
    catch (error) {
      this.unsubscribe(opId);
      handler(this.formatErrors(error));
    }
    return opId;
  }
  getObserver(observerOrNext, error, complete) {
    // Next
    if (typeof observerOrNext === 'function') {
      return {
        next: (value) => observerOrNext(value),
        error: (e) => error && error(e),
        complete: () => complete && complete()
      };
    }
    // Observer
    return observerOrNext;
  }
  createMaxConnectTimeGenerator() {
    const minValue = this.wsMinTimeout;
    const maxValue = this.wsTimeout;
    return new Backoff({
      min: minValue,
      max: maxValue,
      factor: 1.2
    });
  }
  clearCheckConnectionInterval() {
    if (this.checkConnectionIntervalId) {
      clearInterval(this.checkConnectionIntervalId);
      this.checkConnectionIntervalId = null;
    }
  }
  clearMaxConnectTimeout() {
    if (this.maxConnectTimeoutId) {
      clearTimeout(this.maxConnectTimeoutId);
      this.maxConnectTimeoutId = null;
    }
  }
  clearTryReconnectTimeout() {
    if (this.tryReconnectTimeoutId) {
      clearTimeout(this.tryReconnectTimeoutId);
      this.tryReconnectTimeoutId = null;
    }
  }
  clearInactivityTimeout() {
    if (this.inactivityTimeoutId) {
      clearTimeout(this.inactivityTimeoutId);
      this.inactivityTimeoutId = null;
    }
  }
  setInactivityTimeout() {
    if (this.inactivityTimeout > 0 &&
        Object.keys(this.operations).length === 0) {
      this.inactivityTimeoutId = setTimeout(() => {
        if (Object.keys(this.operations).length === 0) {
          this.close();
        }
      }, this.inactivityTimeout);
    }
  }
  checkOperationOptions(options, handler) {
    const { query, variables, operationName } = options;
    if (!query) {
      throw new Error('Must provide a query.');
    }
    if (!handler) {
      throw new Error('Must provide an handler.');
    }
    if (!isString(query) ||
        (operationName && !isString(operationName)) ||
        (variables && !isObject(variables))) {
      throw new Error('Incorrect option types. query must be a string,' +
          '`operationName` must be a string, and `variables` must be an object.');
    }
  }
  buildMessage(id, type, payload) {
    const payloadToReturn = payload && payload.query
        ? Object.assign({}, payload, {
          query: payload.query
        })
        : payload;
    return {
      id,
      type,
      payload: payloadToReturn
    };
  }
  formatErrors(errors) {
    if (Array.isArray(errors)) {
      return errors;
    }
    if (errors && errors.errors) {
      return this.formatErrors(errors.errors);
    }
    if (errors && errors.message) {
      return [errors];
    }
    return [
      {
        name: 'FormatedError',
        message: 'Unknown error',
        originalError: errors
      }
    ];
  }
  sendMessage(id, type, payload) {
    this.sendMessageRaw(this.buildMessage(id, type, payload));
  }
  // send message, or queue it if connection is not open
  sendMessageRaw(message) {
    switch (this.status) {
      case this.webSocket.OPEN:
        const serializedMessage = JSON.stringify(message);
        try {
          JSON.parse(serializedMessage);
        }
        catch (error) {
          this.eventEmitter.emit('error', new Error(`Message must be JSON-serializable. Got: ${message}`));
        }
        this.client.send(serializedMessage);
        break;
      case this.webSocket.CONNECTING:
        this.unsentMessagesQueue.push(message);
        break;
      default:
        if (!this.reconnecting) {
          this.eventEmitter.emit('error', new Error('A message was not sent because socket is not connected, is closing or ' +
              'is already closed. Message was: ' +
              JSON.stringify(message)));
        }
    }
  }
  generateOperationId() {
    return String(++this.nextOperationId);
  }
  tryReconnect() {
    if (!this.reconnect || this.backoff.attempts >= this.reconnectionAttempts) {
      return;
    }
    if (!this.reconnecting) {
      Object.keys(this.operations).forEach(key => {
        this.unsentMessagesQueue.push(this.buildMessage(key, 'start', this.operations[key].options));
      });
      this.reconnecting = true;
    }
    this.clearTryReconnectTimeout();
    const delay = this.backoff.duration();
    this.tryReconnectTimeoutId = setTimeout(() => {
      this.connect();
    }, delay);
  }
  flushUnsentMessagesQueue() {
    this.unsentMessagesQueue.forEach(message => {
      this.sendMessageRaw(message);
    });
    this.unsentMessagesQueue = [];
  }
  checkConnection() {
    if (this.wasKeepAliveReceived) {
      this.wasKeepAliveReceived = false;
      return;
    }
    if (!this.reconnecting) {
      this.close(false, true);
    }
  }
  checkMaxConnectTimeout() {
    this.clearMaxConnectTimeout();
    // Max timeout trying to connect
    this.maxConnectTimeoutId = setTimeout(() => {
      if (this.status !== this.webSocket.OPEN) {
        this.reconnecting = true;
        this.close(false, true);
      }
    }, this.maxConnectTimeGenerator.duration());
  }
  connect() {
    this.client = new WebSocket(this.url, 'graphql-ws');
    this.checkMaxConnectTimeout();
    this.client.addEventListener('open', async () => {
      if (this.status === this.webSocket.OPEN) {
        this.clearMaxConnectTimeout();
        this.closedByUser = false;
        this.eventEmitter.emit(this.reconnecting ? 'reconnecting' : 'connecting');
        try {
          const connectionParams = await this.connectionParams();
          // Send connection_init message, no need to wait for connection to success (reduce roundtrips)
          this.sendMessage(undefined, 'connection_init', connectionParams);
          this.flushUnsentMessagesQueue();
        }
        catch (error) {
          this.sendMessage(undefined, 'connection_error', error);
          this.flushUnsentMessagesQueue();
        }
      }
    });
    this.client.onclose = () => {
      if (!this.closedByUser) {
        this.close(false, false);
      }
    };
    this.client.addEventListener('error', error => {
      // Capture and ignore errors to prevent unhandled exceptions, wait for
      // onclose to fire before attempting a reconnect.
      this.eventEmitter.emit('error', error);
    });
    this.client.addEventListener('message', ({ data }) => {
      let parsedMessage;
      try {
        parsedMessage = JSON.parse(data);
      }
      catch (error) {
        throw new Error(`Message must be JSON-parseable. Got: ${data}`);
      }
      if (Array.isArray(parsedMessage)) {
        for (const message of parsedMessage) {
          this.processReceivedMessage(message);
        }
      }
      else {
        this.processReceivedMessage(parsedMessage);
      }
    });
  }
  processReceivedMessage(message) {
    const opId = message.id;
    if (['data', 'complete', 'error'].includes(message.type) &&
        !this.operations[opId]) {
      this.unsubscribe(opId);
      return;
    }
    switch (message.type) {
      case 'connection_error':
        if (this.connectionCallback) {
          this.connectionCallback(message.payload);
        }
        break;
      case 'connection_ack':
        this.eventEmitter.emit(this.reconnecting ? 'reconnected' : 'connected');
        this.reconnecting = false;
        this.backoff.reset();
        this.maxConnectTimeGenerator.reset();
        if (this.connectionCallback) {
          this.connectionCallback();
        }
        break;
      case 'complete':
        this.operations[opId].handler(null, null);
        delete this.operations[opId];
        break;
      case 'error':
        this.operations[opId].handler(this.formatErrors(message.payload), null);
        delete this.operations[opId];
        break;
      case 'data':
        const parsedPayload = !message.payload.errors
            ? message.payload
            : Object.assign(Object.assign({}, message.payload), { errors: this.formatErrors(message.payload.errors) });
        this.operations[opId].handler(null, parsedPayload);
        break;
      case 'ka':
        const firstKA = typeof this.wasKeepAliveReceived === 'undefined';
        this.wasKeepAliveReceived = true;
        if (firstKA) {
          this.checkConnection();
        }
        if (this.checkConnectionIntervalId) {
          clearInterval(this.checkConnectionIntervalId);
          this.checkConnection();
        }
        this.checkConnectionIntervalId = setInterval(this.checkConnection.bind(this), this.wsTimeout);
        break;
      default:
        throw new Error('Invalid message type!');
    }
  }
  unsubscribe(opId) {
    if (this.operations[opId]) {
      delete this.operations[opId];
      this.setInactivityTimeout();
      this.sendMessage(opId, 'stop', undefined);
    }
  }
}