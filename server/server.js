const http = require('http')

const express = require('express')
const mediasoup = require('mediasoup')
const protoo = require('protoo-server')

let httpServer
let appServer
let socketServer
let mediasoupWorker
let room


run()


async function run() {
  await runMediasoupWorker()
  await createAppServer()
  await runHttpServer()
  await runSocketServer()
}

async function runMediasoupWorker() {
  mediasoupWorker = await mediasoup.createWorker({
    logLevel: 'warn',
    logTags: [
      'info',
      'ice',
      'dtls',
      'rtp',
      'srtp',
      'rtcp',
      'rtx',
      'bwe',
      'score',
      'simulcast',
      'svc',
      'sctp'
    ],
    rtcMinPort : 40000,
    rtcMaxPort : 49999,
  })

  mediasoupWorker.on('died', () => {
    console.error(
      'Mediasoup worker died, exiting in 2 seconds... [pid:%d]', worker.pid
    )
    setTimeout(() => process.exit(1), 2000)
  })

  room = await Room.create({ mediasoupWorker })
  room.on('close', () => {
    console.warn('Room closed')
  })
}

async function createAppServer() {
  appServer = express()
  appServer.use(express.json())

  appServer.get('/room', (req, res) => {
    res.status(200).json(room.getRouterRtpCapabilities())
  })

  appServer.post('/room/broadcasters', async (req, res, next) => {
    const { id, rtpCapabilities } = req.body

    try {
      const data = await room.createBroadcaster({ id, rtpCapabilities })
      res.status(200).json(data)
    }
    catch (error) {
      next(error)
    }
  })

	appServer.delete('/room/broadcasters/:broadcasterId', (req, res) => {
    const { broadcasterId } = req.params
    room.deleteBroadcaster({ broadcasterId })
    res.status(200).send()
  })

  appServer.post('/room/broadcasters/:broadcasterId/transports', async (req, res, next) => {
    const { broadcasterId } = req.params
    const { sctpCapabilities } = req.body

    try {
      const data = await room.createBroadcasterTransport({ broadcasterId, sctpCapabilities })
      res.status(200).json(data)
    } catch (error) {
      next(error)
    }
  })

  appServer.post('/room/broadcasters/:broadcasterId/transports/:transportId/producers', async (req, res, next) => {
    const { broadcasterId, transportId } = req.params;
    const { kind, rtpParameters } = req.body;

    try {
      const data = await room.createBroadcasterProducer({
        broadcasterId,
        transportId,
        kind,
        rtpParameters,
      })
      res.status(200).json(data)
    } catch (error) {
      next(error)
    }
  })

  appServer.post('/room/broadcasters/:broadcasterId/transports/:transportId/consume', async (req, res, next) => {
    const { broadcasterId, transportId } = req.params
    const { producerId } = req.query

    try {
      const data = await room.createBroadcasterConsumer({
        broadcasterId,
        transportId,
        producerId,
      })
      res.status(200).json(data)
    } catch (error) {
      next(error)
    }
  })

  appServer.post('/room/broadcasters/:broadcasterId/transports/:transportId/consume/data', async (req, res, next) => {
    const { broadcasterId, transportId } = req.params
    const { dataProducerId } = req.body

    try {
      const data = await room.createBroadcasterDataConsumer({
        broadcasterId,
        transportId,
        dataProducerId,
      })
      res.status(200).json(data)
    } catch (error) {
      next(error)
    }
  })

  appServer.post('/room/broadcasters/:broadcasterId/transports/:transportId/produce/data', async (req, res, next) => {
    const { broadcasterId, transportId } = req.params
    const { label, protocol, sctpStreamParameters, appData } = req.body

    try {
      const data = await room.createBroadcasterDataProducer({
        broadcasterId,
        transportId,
        label,
        protocol,
        sctpStreamParameters,
        appData,
      })
      res.status(200).json(data)
    } catch (error) {
      next(error)
    }
  })

  appServer.use((error, req, res, next) => {
    if (error) {
      console.warn('App server error: %s', String(error))
      error.status = error.status || (error.name === 'TypeError' ? 400 : 500)
      res.statusMessage = error.message
      res.status(error.status).send(String(error))
    } else {
      next()
    }
  })
}

async function runHttpServer() {
  httpServer = http.createServer(appServer)
  await new Promise((resolve) => {
    httpServer.listen(8080, 'localhost', resolve)
  })
}

async function runSocketServer() {
  // Create the protoo WebSocket server.
  socketServer = new protoo.WebSocketServer(httpServer, {
    maxReceivedFrameSize     : 960000, // 960 KBytes.
    maxReceivedMessageSize   : 960000,
    fragmentOutgoingMessages : true,
    fragmentationThreshold   : 960000
  })

  const baseURL = `${req.protocol}://${req.headers.host}/`
  const url = new URL(req.url, baseURL)
  const peerId  = url.searchParams['peerId']

  if (!peerId) {
    reject(400, 'Connection request without peerId')
    return
  }

  try {
    room.handleProtooConnection({ peerId, accept() })
  } catch (error) {
    console.error('Room creation or room joining failed: %o', error)
    reject(error)
  }
}
