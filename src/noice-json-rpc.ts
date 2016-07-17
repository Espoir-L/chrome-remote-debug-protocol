import {EventEmitter} from 'events'
import * as JsonRpc2 from './jsonRpc'

export interface LikeSocket {
    send(message: string): void
    on(event: string, cb: Function): this;
    removeListener(event: string, cb: Function): this;

    on(event: 'open', cb: (ws: LikeSocket) => void ): this
    on(event: 'message', cb: (data: string) => void): this;
    on(event: 'error', cb: (err: Error) => void ): this
}

export interface LikeSocketServer {
    on(event: string, cb: Function): this;
    on(event: 'connection', cb: (ws: LikeSocket) => void ): this
    on(event: 'error', cb: (err: Error) => void ): this
    clients?: LikeSocket[]
}

export interface LogOpts {
    /** All messages will be emmitted and can be handled by client.on('receive', (msg: string) => void) and client.on('send', (msg: string) => any)  */
    logEmit?: boolean

    /** All messages will be logged to console */
    logConsole?: boolean
}

export interface ClientOpts extends LogOpts {
}

export interface ServerOpts extends LogOpts {
}

/**
 * Creates a RPC Client.
 * It is intentional that Client does not create a WebSocket object since we prefer composability
 * The Client can be used to communicate over processes, http or anything that can send and receive strings
 * It just needs to pass in an object that implements LikeSocket interface
 */
export class Client extends EventEmitter implements JsonRpc2.Client{
    private static ConnectTimeout = 5000

    private _connectedPromise: Promise<Client>
    private _socket: LikeSocket
    private _pendingMessageMap: Map<number, {resolve: Function, reject: Function}> = new Map()
    private _nextMessageId: number = 0
    private _emitLog: boolean = false;
    private _consoleLog: boolean = false;

    constructor(socket: LikeSocket, opts?: ClientOpts){
        super()
        this.setLogging(opts)

        this._connectedPromise = new Promise((resolve, reject) => {
            this._socket = socket

            socket.on('error', reject)
            socket.on('open', () => {
                // Replace the promise-rejecting handler
                socket.removeListener('error', reject)
                socket.on('error', e => this.emit('error', e))
                resolve(this)
            })

            socket.on('close', () => this.emit('close'))
            socket.on('message', message => this.processMessage(message))
        })
    }

    public processMessage(messageStr: string) {
        this._logMessage(messageStr, "receive")
        let message: JsonRpc2.Response & JsonRpc2.Notification

        // Ensure JSON is not malformed
        try {
            message = JSON.parse(messageStr)
        } catch (e) {
            return this.emit('error', e)
        }

        // Check that messages is well formed
        if (!message){
            this.emit('error', new Error(`Malformed message: ${messageStr}`))
        } else if (message.id) {
            if (this._pendingMessageMap.has(message.id)) {
                // Resolve promise from pending message
                const promise = this._pendingMessageMap.get(message.id)
                if (message.result) {
                    promise.resolve(message.result)
                } else if (message.error) {
                    promise.reject(message.error)
                } else {
                    this.emit('error', new Error(`Invalid message: ${messageStr}`))
                }
            } else {
                this.emit('error', new Error(`Response with id ${message.id} has no pending request.`))
            }
        } else if (message.method) {
            // Server has sent a notification
            this.emit(message.method, message.params)
        }
    }

    /** Set logging for all received and sent messages */
    public setLogging({logEmit, logConsole}: LogOpts = {}) {
        this._emitLog = logEmit
        this._consoleLog = logConsole
    }

    private _send(message: JsonRpc2.Notification | JsonRpc2.Request) {
        const messsageStr = JSON.stringify(message)
        this._logMessage(messsageStr, "send")
        this._socket.send(messsageStr)
    }

    private _logMessage(message: string, direction: "send" | "receive") {
        if (this._consoleLog) {
            console.log(`Client ${direction === "send" ? ">" : "<"}`, message)
        }

        if (this._emitLog) {
            this.emit(direction, message)
        }
    }

    call(method: string, params?: any): Promise<any> {
        const id = ++this._nextMessageId;
        const message: JsonRpc2.Request = {id, method, params}

        return new Promise((resolve, reject) => {
            this._pendingMessageMap.set(id, {resolve, reject})
            this._connectedPromise.then(() => this._send(message))
        })
    }

    notify(method: string, params?: any): void {
        this._send({method, params})
    }

    /**
     * Builds an ES6 Proxy where api.domain.method(params) transates into client.send('{domain}.{method}', params) calls
     * api.domain.on{method} will add event handlers for {method} events
     * api.domain.emit{method} will send {method} notifications to the server
     * The api object leads itself to a very clean interface i.e `await api.Domain.func(params)` calls
     * This allows the consumer to abstract all the internal details of marshalling the message from function call to a string
     */
    api(domain?: string): any {
        if (!Proxy) {
            throw new Error("api() requires ES6 Proxy. Please use an ES6 compatible engine")
        }

        return new Proxy({}, {
            get: (target: any, prop: string) => {
                if (target[prop]) {
                    return target[prop]
                }

                if (prop == "__proto__") {
                    return Object.prototype
                } else if (!domain) {
                    target[prop] = this.api(prop)
                } else if (prop.substr(0,2) === "on" && prop.length > 3){
                    const method = prop[2].toLowerCase() + prop.substr(3)
                    target[prop] = (handler: Function) => this.on(`${domain}.${method}`, handler)
                } else if (prop.substr(0,4) === "emit" && prop.length > 5){
                    const method = prop[4].toLowerCase() + prop.substr(5)
                    target[prop] = (params: any) => this.notify(`${domain}.${method}`, params)
                } else {
                    const method = prop
                    target[prop] = (params: any) => this.call(`${domain}.${method}`, params)
                }

                return target[prop]
            }
        })
    }
}

/**
 * Creates a RPC Server.
 * It is intentional that Server does not create a WebSocketServer object since we prefer composability
 * The Server can be used to communicate over processes, http or anything that can send and receive strings
 * It just needs to pass in an object that implements LikeSocketServer interface
 */
export class Server extends EventEmitter implements JsonRpc2.Server {
    private _socketServer: LikeSocketServer
    private _exposedMethodsMap: Map<string, (params: any) => JsonRpc2.PromiseOrNot<any>> = new Map()
    private _emitLog: boolean = false;
    private _consoleLog: boolean = false;

    constructor (server: LikeSocketServer, opts?:ServerOpts) {
        super()
        this.setLogging(opts)
        this._socketServer = server
        server.on('error', (e) => this.emit('error', e))

        server.on('connection', socket => {
            socket.on('message', message => this.processMessage(message, socket))
        })
    }

    private processMessage(messageStr: string, socket: LikeSocket): void {
        this._logMessage(messageStr, "receive")
        let message: JsonRpc2.Request

        // Ensure JSON is not malformed
        try {
            message = JSON.parse(messageStr)
        } catch (e) {
            return this._sendError(socket, message, JsonRpc2.ErrorCode.ParseError)
        }


        // Ensure method is atleast defined
        if (message && message.method && typeof message.method == "string") {
            if (message.id && typeof message.id === "number") {
                const handler = this._exposedMethodsMap.get(message.method)
                // Handler is defined so lets call it
                if (handler) {
                    try {
                        const result: JsonRpc2.PromiseOrNot<any> = handler.call(null, message.params)
                        if (result instanceof Promise) {
                            // Result is a promise, so lets wait for the result and handle accordingly
                            result.then((actualResult: any) => {
                                this._send(socket, {id: message.id, result: actualResult || {}})
                            }).catch((error: Error) => {
                                this._sendError(socket, message, JsonRpc2.ErrorCode.InternalError, error);
                            })
                        } else {
                            // Result is not a promise so send immediately
                            this._send(socket, {id: message.id, result: result || {}})
                        }
                    } catch (error) {
                        this._sendError(socket, message, JsonRpc2.ErrorCode.InternalError, error);
                    }
                } else {
                    this._sendError(socket, message, JsonRpc2.ErrorCode.MethodNotFound)
                }
            } else {
                // Message is a notification, so just emit
                this.emit(message.method, message.params)
            }
        } else {
            // No method property, send InvalidRequest error
            this._sendError(socket, message, JsonRpc2.ErrorCode.InvalidRequest)
        }
    }

    /** Set logging for all received and sent messages */
    public setLogging({logEmit, logConsole}: LogOpts = {}) {
        this._emitLog = logEmit
        this._consoleLog = logConsole
    }

    private _logMessage(messageStr: string, direction: "send" | "receive") {
        if (this._consoleLog) {
            console.log(`Server ${direction === "send" ? ">" : "<"}`, messageStr)
        }

        if (this._emitLog) {
            this.emit(direction, messageStr)
        }
    }

    private _send(socket: LikeSocket, message: JsonRpc2.Response | JsonRpc2.Notification ) {
        const messageStr = JSON.stringify(message)
        this._logMessage(messageStr, "send")
        socket.send(messageStr)
    }

    private _sendError(socket: LikeSocket, request: JsonRpc2.Request, errorCode: JsonRpc2.ErrorCode, errorData?: any) {
        this._send(socket, {
            id: request && request.id || -1,
            error: this._errorFromCode(errorCode, errorData, request.method)
        })
    }

    private _errorFromCode(code: JsonRpc2.ErrorCode, data?: any, method?: string): JsonRpc2.Error {
        let message = ""

        switch (code) {
            case JsonRpc2.ErrorCode.InternalError:
                message =  `InternalError: Internal Error when calling '${method}'`
                break
            case JsonRpc2.ErrorCode.MethodNotFound:
                message =  `MethodNotFound: '${method}' wasn't found`
                break
            case JsonRpc2.ErrorCode.InvalidRequest:
                message =  "InvalidRequest: JSON sent is not a valid request object"
                break
            case JsonRpc2.ErrorCode.ParseError:
                message =  "ParseError: invalid JSON received"
                break
        }

        return {code, message, data}
    }

    expose(method: string, handler: (params: any) => Promise<any>): void {
        this._exposedMethodsMap.set(method, handler)
    }

    notify (method: string, params?: any): void {
        // Broadcast message to all clients
        if (this._socketServer.clients) {
            this._socketServer.clients.forEach(ws => {
                this._send(ws, {method, params})
            })
        } else {
            throw new Error("SocketServer does not support broadcasting. No 'clients: LikeSocket[]' property found")
        }
    }

    /**
     * Builds an ES6 Proxy where api.domain.expose(module) exposes all the functions in the module over RPC
     * api.domain.emit{method} calls will send {method} notifications to the client
     * The api object leads itself to a very clean interface i.e `await api.Domain.func(params)` calls
     * This allows the consumer to abstract all the internal details of marshalling the message from function call to a string
     */
    api(domain?: string): any {
        if (!Proxy) {
            throw new Error("api() requires ES6 Proxy. Please use an ES6 compatible engine")
        }

        return new Proxy({}, {
            get: (target: any, prop: string) => {
                if (target[prop]) {
                    return target[prop]
                }

                if (prop == "__proto__") {
                    return Object.prototype
                } else if (!domain) {
                    target[prop] = this.api(prop)
                } else if (prop.substr(0,2) === "on" && prop.length > 3){
                    const method = prop[2].toLowerCase() + prop.substr(3)
                    target[prop] = (handler: Function) => this.on(`${domain}.${method}`, handler)
                } else if (prop.substr(0,4) === "emit" && prop.length > 5){
                    const method = prop[4].toLowerCase() + prop.substr(5)
                    target[prop] = (params: any) => this.notify(`${domain}.${method}`, params)
                } else if (prop === "expose"){
                    target[prop] = (module: any) => {
                        if (!module) throw new Error("An iterable object expected to expose functions")
                        for (let funcName in module) {
                            if (typeof module[funcName] === "function") {
                                this.expose(`${domain}.${funcName}`, module[funcName].bind(module))
                            }
                        }
                    }
                } else {
                    return null
                }

                return target[prop]
            }
        })
    }
}