import protooClient from 'protoo-client'
import * as mediasoupClient from 'mediasoup-client'
import { random } from 'lodash'

const protooUrl = 'ws://localhost:8000?peerId=peer-'

let mediasoupDevice = null
let sendTransport = null
let recvTransport = null
let closed = false
let protoo = null
let webcamProducer = null
let consumers = new Map()

let peers = {}

join()

function closeConnections() {
  if (closed) {
    return
  }

  closed = true
  console.debug('close()')

  protoo.close()

  if (sendTransport) {
    sendTransport.close()
  }

  if (recvTransport) {
    recvTransport.close()
  }
}

async function join() {
  const randomPeerId = random(1, 1000000)
  console.debug("PeerId %i", randomPeerId)
  const protooTransport = new protooClient.WebSocketTransport(protooUrl + randomPeerId)
  protoo = new protooClient.Peer(protooTransport)

  protoo.on('open', () => _joinRoom())

  protoo.on('failed', () => {
    console.error('failed websocket')
  })

  protoo.on('disconnected', () => {
    console.error('disconnected')

    if (sendTransport) {
      sendTransport.close()
      sendTransport = null
    }

    if (recvTransport) {
      recvTransport.close()
      recvTransport = null
    }
  })

  protoo.on('close', () => {
    if (this._closed) {
      return;
    }
    this.close()
  })

  protoo.on('request', async (request, accept, reject) => {
    console.debug('proto "request" event [method:%s, data:%o]', request.method, request.data)
    switch (request.method) {
      case 'newConsumer': {
        const {
          peerId,
          producerId,
          id,
          kind,
          rtpParameters,
          appData,
        } = request.data

        try {
          const consumer = await recvTransport.consume({
            id,
            producerId,
            kind,
            rtpParameters,
            appData : { ...appData, peerId },
          })

          consumers.set(consumer.id, consumer)

          if (kind === "video") {
            let video = document.createElement('video')
            video.srcObject = new MediaStream([consumer._track])
            video.playsInline = true
            video.width = 320
            video.height = 240
            video.autoplay = true
            document.getElementById('other-video').appendChild(video)
          }

          consumer.on('transportclose', () => {
            consumers.delete(consumer.id)
          })
          accept()
        } catch (error) {
          console.error('"newConsumer" request failed:%o', error)
          throw error
        }
        break
      }
    }
  })

  protoo.on('notification', (notification) => {
    console.debug('proto "notification" event [method:%s, data:%o]', notification.method, notification.data)

    switch (notification.method) {
      case 'newPeer': {
        const peer = notification.data
        peers[peer.id] = { ...peer,  consumers: [] }
        break
      }

      case 'peerClosed': {
        const { peerId } = notification.data
        delete peers[peerId]
        break
      }

      case 'consumerClosed': {
        const { consumerId } = notification.data
        const consumer = consumers.get(consumerId)

        if (!consumer) {
          break
        }

        consumer.close()
        consumers.delete(consumerId)

        const { peerId } = consumer.appData

        peers[peerId].consumers = peers[peerId].consumers.filter(e => e !== consumerId)
        break
      }

      default: {
        console.error('unknown protoo notification.method "%s"', notification.method)
      }
    }
  })
}

async function enableMic() {
  console.debug('enableMic()')
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    let track = stream.getAudioTracks()[0]
    micProducer = await sendTransport.produce({
      track,
      codecOptions: {
        opusStereo: 1,
        opusDtx: 1,
      }
    })
    micProducer.on('transportclose', () => {
      micProducer = null;
    })
  } catch (error) {
    console.error('enableMic() | failed:%o', error)
    if (track) {
      track.stop()
    }
  }
}

async function enableWebcam() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true })
    track = stream.getVideoTracks()[0]
    const codecOptions = {
      videoGoogleStartBitrate: 1000,
    }

    let video = document.createElement('video')
    video.srcObject = new MediaStream([track])
    video.playsInline = true
    video.width = 640
    video.height = 480
    video.autoplay = true
    document.getElementById('me-video').appendChild(video)

    webcamProducer = await sendTransport.produce({ track, codecOptions })

    webcamProducer.on('transportclose', () => {
      webcamProducer = null
    })
  } catch (error) {
    console.error('enableWebcam() | failed:%o', error)
    if (track) {
      track.stop()
    }
  }
}

async function _joinRoom() {
  console.debug('_joinRoom()')

  try {
    mediasoupDevice = new mediasoupClient.Device()
    const routerRtpCapabilities = await protoo.request('getRouterRtpCapabilities')
    await mediasoupDevice.load({ routerRtpCapabilities })

    let transportInfo = await protoo.request('createWebRtcTransport', {
        producing: true,
        consuming: false,
        sctpCapabilities: false,
      })

    const {
      id,
      iceParameters,
      iceCandidates,
      dtlsParameters,
      sctpParameters
    } = transportInfo

    sendTransport = mediasoupDevice.createSendTransport({
      id,
      iceParameters,
      iceCandidates,
      dtlsParameters,
      sctpParameters,
      iceServers: [
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
        { urls: 'stun:stun3.l.google.com:19302' },
        { urls: 'stun:stun4.l.google.com:19302' },
      ],
    })

    sendTransport.on('connect', ({ dtlsParameters }, callback, errback) => {
      protoo.request('connectWebRtcTransport', {
        transportId : sendTransport.id,
        dtlsParameters,
      })
      .then(callback)
      .catch(errback)
    })

    sendTransport.on('produce', async ({ kind, rtpParameters, appData }, callback, errback) => {
      try {
        const { id } = await protoo.request('produce', {
          transportId: sendTransport.id,
          kind,
          rtpParameters,
          appData,
        })
        callback({ id })
      } catch (error) {
        errback(error)
      }
    })

    transportInfo = await protoo.request('createWebRtcTransport', {
      producing: false,
      consuming: true,
      sctpCapabilities: false,
    })

    recvTransport = mediasoupDevice.createRecvTransport({
      id: transportInfo.id,
      iceParameters: transportInfo.iceParameters,
      iceCandidates: transportInfo.iceCandidates,
      dtlsParameters: transportInfo.dtlsParameters,
      sctpParameters: transportInfo.sctpCapabilities,
      iceServers : [],
    })

    recvTransport.on('connect', ({ dtlsParameters }, callback, errback) => {
      protoo.request('connectWebRtcTransport', {
        transportId: recvTransport.id,
        dtlsParameters,
      })
      .then(callback)
      .catch(errback)
    })

    const { peers } = await protoo.request('join', {
      rtpCapabilities : mediasoupDevice.rtpCapabilities
    })

    for (const peer of peers) {
      peers[peer.id] = {...peer, consumers: []}
    }

    enableMic()
    enableWebcam()

    sendTransport.on('connectionstatechange', (connectionState) => {
      console.debug('Connection state changed')
    })
  } catch (error) {
    console.error('_joinRoom() failed:%o', error)
    closeConnections()
  }
}
