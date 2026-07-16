import uWS from 'uWebSockets.js'
import type { us_listen_socket, WebSocket as UwsSocket } from 'uWebSockets.js'

import type { Bytes, Connection, ServerTransport } from '@mp/core'

interface ConnectionImpl extends Connection {
  _emitMessage: (data: Bytes) => void
  _emitClose: () => void
}

interface ConnUserData {
  conn: ConnectionImpl | null
}

const makeConnection = (ws: UwsSocket<ConnUserData>, id: number): ConnectionImpl => {
  let messageHandler: ((data: Bytes) => void) | null = null
  let closeHandler: (() => void) | null = null
  return {
    id,
    send: (data) => {
      ws.send(data, true) // isBinary
    },
    close: () => {
      ws.end()
    },
    onMessage: (h) => {
      messageHandler = h
    },
    onClose: (h) => {
      closeHandler = h
    },
    _emitMessage: (data) => messageHandler?.(data),
    _emitClose: () => closeHandler?.(),
  }
}

export interface UwsServerTransport extends ServerTransport {
  readonly port: number
}

/** uWebSockets.js implementation of {@link ServerTransport}. Resolves once listening. */
export const createUwsServerTransport = (opts: { port: number }): Promise<UwsServerTransport> =>
  new Promise((resolve, reject) => {
    let connectionHandler: ((conn: Connection) => void) | null = null
    let nextId = 1

    const app = uWS.App().ws<ConnUserData>('/*', {
      idleTimeout: 0,
      maxPayloadLength: 16 * 1024,
      open: (ws) => {
        const conn = makeConnection(ws, nextId++)
        ws.getUserData().conn = conn
        connectionHandler?.(conn)
      },
      message: (ws, message) => {
        // uWS neuters the buffer after this callback returns — copy before handoff.
        ws.getUserData().conn?._emitMessage(message.slice(0))
      },
      close: (ws) => {
        ws.getUserData().conn?._emitClose()
      },
    })

    app.listen(opts.port, (token: us_listen_socket | false) => {
      if (!token) {
        reject(new Error(`failed to listen on port ${opts.port}`))
        return
      }
      resolve({
        port: opts.port,
        onConnection: (h) => {
          connectionHandler = h
        },
        close: () => {
          uWS.us_listen_socket_close(token)
          app.close()
        },
      })
    })
  })
