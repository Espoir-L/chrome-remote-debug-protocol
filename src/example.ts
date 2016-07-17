/// <reference path="../typings/index.d.ts" />
import * as fs from 'fs'
import * as WebSocket from 'ws'
import WebSocketServer = WebSocket.Server
import * as http from 'http'
import Crdi from './crdi'
import * as rpc from './noice-json-rpc'

async function setupClient() {
    try {
        const api = new rpc.Client(new WebSocket("ws://localhost:8080"), {logConsole: true}).api()

        await Promise.all([
            api.Runtime.enable(),
            api.Debugger.enable(),
            api.Profiler.enable(),
            api.Runtime.run(),
        ])

        await api.Profiler.start()
        await new Promise((resolve) => api.Runtime.onExecutionContextDestroyed(resolve)); // Wait for event
        await api.Profiler.stop()

    } catch (e) {
        console.error(e)
    }
}

function setupServer() {
    const wssServer = new WebSocketServer({port: 8080});
    const api = new rpc.Server(wssServer).api();

    const enable = () => {}

    api.Debugger.expose({enable})
    api.Profiler.expose({enable})
    api.Runtime.expose({
        enable,
        run() {}
    })
    api.Profiler.expose({
        enable,
        start() {
            setTimeout(() => {
                api.Runtime.emitExecutionContextDestroyed()
            }, 1000)
        },
        stop() {
            return {data: "noice!"}
        }
    })

}

setupServer()
setupClient()