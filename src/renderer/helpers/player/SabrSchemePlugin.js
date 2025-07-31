import { base64ToU8, concatenateChunks, EventEmitterLike } from 'googlevideo/utils'
import { CompositeBuffer, UmpReader } from 'googlevideo/ump'
import {
  UMPPartId,
  VideoPlaybackAbrRequest,
  StreamProtectionStatus,
  SabrError,
  SabrRedirect,
  MediaHeader,
  FormatInitializationMetadata,
  SabrContextSendingPolicy,
  SabrContextUpdate,
  SabrContextWritePolicy,
  NextRequestPolicy,
  PlaybackCookie,
  SnackbarMessage,
  PlaybackStartPolicy,
  RequestCancellationPolicy,
  ReloadPlaybackContext,
} from 'googlevideo/protos'
import shaka from 'shaka-player'

import { deepCopy } from '../utils'

const AbortableOperation = shaka.util.AbortableOperation
const ShakaError = shaka.util.Error

/**
 * @typedef OperationInputs
 * @type {object}
 * @property {string} uri
 * @property {shaka.extern.Request} request
 * @property {shaka.net.NetworkingEngine.RequestType} requestType
 * @property {shaka.extern.HeadersReceived} headersReceived
 * The following are calculated from above properties
 * @property {string} formatIdString
 * @property {boolean} isInit
 * @property {number} sequenceNumber
 */
/**
 * @typedef AbortStatus
 * @type {object}
 * @property {boolean} cancelled
 * @property {boolean} timedOut
 * @property {boolean} playerReloadRequested
 * @property {boolean} finished
 */
/**
 * @typedef CurrentState
 * @type {object}
 * @property {string} sabrUrl
 * @property {Map<string, Uint8Array>} initDataCache
 * @property {Map<number, SabrContextUpdate>} sabrContexts
 * @property {Set<number>} activeSabrContextTypes
 * @property {VideoPlaybackAbrRequest} abrRequest
 * @property {RequestInit} requestInit
 * @property {AbortStatus} abortStatus
 * @property {AbortController} abortController
 * @property {SabrStreamState} sabrStreamState
 * @property {?TimeoutController} timeoutController
 * @property {?EventEmitterLike} eventEmitter
 */

/**
 * @param {string} str
 */
function formatIdFromString(str) {
  const videoFormatIdParts = str.split('-')

  return {
    itag: parseInt(videoFormatIdParts[0]),
    lastModified: parseInt(videoFormatIdParts[1]),
    xtags: videoFormatIdParts[2]
  }
}

/**
 * @param {Protos.FormatId} formatId
 * @param {shaka.extern.BufferedRange} buffered
 * @param {shaka.media.SegmentIndex} segmentIndex
 */
function createBufferedRange(formatId, buffered, segmentIndex) {
  let endSegmentIndex = segmentIndex.find(buffered.end)
  if (endSegmentIndex == null) {
    // Using Last end time will get `null` in `segmentIndex.find`
    endSegmentIndex = segmentIndex.find(buffered.end - 0.001)
  }

  return {
    formatId,
    startTimeMs: Math.trunc(buffered.start * 1000),
    durationMs: Math.trunc((buffered.end - buffered.start) * 1000),
    startSegmentIndex: segmentIndex.find(buffered.start),
    endSegmentIndex: endSegmentIndex,
  }
}

/**
 * @param {shaka.Player} player
 * @param {shaka.extern.Manifest} manifest
 * @param {boolean} audioFormatsActive
 * @param {Protos.BufferedRange[]} bufferedRanges
 * @param {shaka.extern.Track} activeVariant
 */
function fillBufferedRanges(player, manifest, audioFormatsActive, bufferedRanges, activeVariant) {
  const bufferedInfo = player.getBufferedInfo()

  if (bufferedInfo.audio.length > 0 || bufferedInfo.video.length > 0) {
    let activeManifestVariant
    if (audioFormatsActive) {
      activeManifestVariant = manifest.variants.find((variant) => {
        return variant.audio.originalId === activeVariant.originalAudioId
      })
    } else {
      activeManifestVariant = manifest.variants.find((variant) => {
        return variant.audio.originalId === activeVariant.originalAudioId &&
          variant.video.originalId === activeVariant.originalVideoId
      })
    }

    const audioFormatId = formatIdFromString(activeVariant.originalAudioId)
    const audioSegmentIndex = activeManifestVariant.audio.segmentIndex

    for (const buffered of bufferedInfo.audio) {
      bufferedRanges.push(createBufferedRange(audioFormatId, buffered, audioSegmentIndex))
    }

    // Lazily initalise these variables as video data won't exist for audio-only playback
    let videoFormatId
    let videoSegmentIndex

    for (const buffered of bufferedInfo.video) {
      if (!videoFormatId) {
        videoFormatId = formatIdFromString(activeVariant.originalVideoId)
      }

      if (!videoSegmentIndex) {
        videoSegmentIndex = activeManifestVariant.video.segmentIndex
      }

      bufferedRanges.push(createBufferedRange(videoFormatId, buffered, videoSegmentIndex))
    }
  }
}

/**
 * @param {string} uri
 * @param {shaka.extern.Request} request
 * @param {Uint8Array} data
 * @returns {shaka.util.AbortableOperation<shaka.extern.Response>}
 */
function createCacheResponse(uri, request, data) {
  return AbortableOperation.completed({
    data,
    fromCache: true,
    headers: {},
    originalRequest: request,
    originalUri: uri,
    uri
  })
}

/**
 * @param {shaka.util.Error.Code} code
 * @param {...any} args
 */
function createRecoverableNetworkError(code, ...args) {
  return new ShakaError(ShakaError.Severity.RECOVERABLE, ShakaError.Category.NETWORK, code, ...args)
}

/**
 * @param {SabrStreamState} sabrStreamState
 */
function prepareSabrContexts(sabrStreamState) {
  /** @type {SabrContextUpdate[]} */
  const sabrContexts = []
  /** @type {number[]} */
  const unsentSabrContexts = []

  for (const ctxUpdate of sabrStreamState.sabrContexts.values()) {
    if (sabrStreamState.activeSabrContextTypes.has(ctxUpdate.type)) {
      sabrContexts.push(ctxUpdate)
    } else {
      unsentSabrContexts.push(ctxUpdate.type)
    }
  }

  return { sabrContexts, unsentSabrContexts }
}

/**
 * @template T
 * @param {import('googlevideo/shared-types').Part} part
 * @param {{ decode: (data: Uint8Array) => T }} decoder
 * @returns {T | undefined}
 */
function decodePart(part, decoder) {
  if (!part.data.chunks.length) return undefined

  try {
    return decoder.decode(concatenateChunks(part.data.chunks))
  } catch {
    return undefined
  }
}

/**
 * @typedef TimeoutController
 * @type {object}
 * @property {() => void} resetTimeout
 * @property {() => void} clearTimeout
 */
/**
 * @param {(args: void) => void} callback
 * @param {number} timeoutMs
 * @return TimeoutController
 */
function createTimeoutController(callback, timeoutMs) {
  return {
    _timeout: setTimeout(callback, timeoutMs),
    resetTimeout() {
      this.clearTimeout()
      this._timeout = setTimeout(callback, timeoutMs)
    },
    clearTimeout() {
      clearTimeout(this._timeout)
    },
  }
}

/**
 * @param {OperationInputs} operationInputs - readonly
 * @param {CurrentState} currentState - can be updated
 */
async function doRequest(
  operationInputs,
  currentState,
) {
  let response
  /** @type {CompositeBuffer | null} */
  let chunkedDataBuffer = null
  /** @type {Uint8Array[]} */
  const responseDataChunks = []
  let segmentComplete = false
  let shouldRetry = false

  let invalidPoToken = false
  let error
  /** @type {import('googlevideo').Part[]} */
  const parts = []
  /** @type {({ type: string, data: {[string]: unknown }|string) }[]} */
  const debugEntries = []

  try {
    if ((currentState.sabrStreamState.nextRequestPolicy?.backoffTimeMs || 0) > 0) {
      console.warn(`Waiting ${currentState.sabrStreamState.nextRequestPolicy?.backoffTimeMs}ms according to nextRequestPolicy`)
      currentState.eventEmitter.emit('backoff-requested', { backoffMs: currentState.sabrStreamState.nextRequestPolicy?.backoffTimeMs })
      // Wait but can be aborted
      await new Promise((resolve, reject) => {
        setTimeout(resolve, currentState.sabrStreamState.nextRequestPolicy?.backoffTimeMs)
        currentState.abortController.signal.addEventListener('abort', reject)
      })
      // Must reset AFTER waiting to avoid requested aborted
      currentState.timeoutController.resetTimeout()
    }
    response = await fetch(currentState.sabrUrl, currentState.requestInit)
    debugEntries.push({
      type: 'response',
      data: {
        response,
      }
    })

    operationInputs.headersReceived({})

    const { itag, lastModified, xtags } = formatIdFromString(operationInputs.formatIdString)
    let mediaHeaderId
    debugEntries.push({
      type: 'formatIdFromString',
      data: {
        itag,
        lastModified,
        xtags,
      }
    })

    const reader = response.body.getReader()
    let readObj = await reader.read()
    debugEntries.push({
      type: 'readObj',
      data: {
        readObj,
        abortStatus: currentState.abortStatus,
      }
    })

    while (!readObj.done && !currentState.abortStatus.finished) {
      // debugEntries.push({
      //   type: 'whileLoopStart',
      //   data: {
      //     chunkedDataBuffer,
      //   }
      // })
      if (chunkedDataBuffer) {
        chunkedDataBuffer.append(readObj.value)
      } else {
        chunkedDataBuffer = new CompositeBuffer([readObj.value])
      }

      const remainingData = new UmpReader(chunkedDataBuffer).read((part) => {
        parts.push(part)
        switch (part.type) {
          case UMPPartId.STREAM_PROTECTION_STATUS: {
            const streamProtectionStatus = decodePart(part, StreamProtectionStatus)
            if (streamProtectionStatus.status === 3) {
              invalidPoToken = true
            }
            debugEntries.push({ type: 'STREAM_PROTECTION_STATUS', data: { streamProtectionStatus } })
            break
          }
          case UMPPartId.SABR_ERROR: {
            const sabrError = decodePart(part, SabrError)
            error = `SABR Error: type: ${sabrError.type}, code: ${sabrError.code}`
            debugEntries.push({ type: 'SABR_ERROR', data: { error } })
            break
          }
          case UMPPartId.SABR_REDIRECT: {
            const sabrRedirect = decodePart(part, SabrRedirect)
            currentState.sabrUrl = sabrRedirect.url
            shouldRetry = true
            debugEntries.push({ type: 'SABR_REDIRECT', data: { redirectUrl: sabrRedirect.url } })
            break
          }
          case UMPPartId.MEDIA_HEADER: {
            if (mediaHeaderId === undefined) {
              const mediaHeader = decodePart(part, MediaHeader)
              debugEntries.push({
                type: 'MEDIA_HEADER',
                mediaHeaderId,
                remoteMediaHeaderId: mediaHeader.headerId,
                data: {
                  isInit: operationInputs.isInit,
                  sequenceNumber: operationInputs.sequenceNumber,
                  mediaHeader_isInitSeg: mediaHeader.isInitSeg,
                  mediaHeader_sequenceNumber: mediaHeader.sequenceNumber,
                  mediaHeader_formatId: mediaHeader.formatId,
                },
              })

              if (
                mediaHeader.formatId.itag === itag &&
                mediaHeader.formatId.lastModified === lastModified &&
                mediaHeader.formatId.xtags === xtags
              ) {
                if (operationInputs.isInit && mediaHeader.isInitSeg) {
                  mediaHeaderId = mediaHeader.headerId
                } else if (!operationInputs.isInit && mediaHeader.sequenceNumber === operationInputs.sequenceNumber) {
                  mediaHeaderId = mediaHeader.headerId
                }
              }
            }

            break
          }
          case UMPPartId.MEDIA: {
            debugEntries.push({
              type: 'MEDIA',
              data: {
                mediaHeaderId,
                remoteMediaHeaderId: part.data.getUint8(0),
                chunks: part.data.split(1).remainingBuffer.chunks,
              },
            })
            if (mediaHeaderId === part.data.getUint8(0)) {
              responseDataChunks.push(...part.data.split(1).remainingBuffer.chunks)
            }
            break
          }
          case UMPPartId.MEDIA_END: {
            debugEntries.push({
              type: 'MEDIA_END',
              data: {
                mediaHeaderId,
                remoteMediaHeaderId: part.data.getUint8(0),
              },
            })
            if (mediaHeaderId === part.data.getUint8(0)) {
              segmentComplete = true
              currentState.abortStatus.finished = true
              currentState.abortController.abort()
            }
            break
          }
          case UMPPartId.NEXT_REQUEST_POLICY: {
            const nextRequestPolicy = decodePart(part, NextRequestPolicy)
            currentState.sabrStreamState.nextRequestPolicy = nextRequestPolicy
            shouldRetry = true
            if (nextRequestPolicy?.playbackCookie) {
              currentState.abrRequest.streamerContext.playbackCookie = PlaybackCookie.encode(nextRequestPolicy?.playbackCookie).finish()
            }
            if (nextRequestPolicy?.backoffTimeMs) {
              currentState.abrRequest.streamerContext.backoffTimeMs = nextRequestPolicy?.backoffTimeMs
            }
            debugEntries.push({
              type: 'NEXT_REQUEST_POLICY',
              data: {
                nextRequestPolicy: nextRequestPolicy,
              },
            })
            break
          }
          case UMPPartId.FORMAT_INITIALIZATION_METADATA: {
            debugEntries.push({
              type: 'FORMAT_INITIALIZATION_METADATA',
              data: {
                formatInitializationMetadata: decodePart(part, FormatInitializationMetadata),
              },
            })
            break
          }
          case UMPPartId.SABR_CONTEXT_UPDATE: {
            const sabrContextUpdate = decodePart(part, SabrContextUpdate)
            debugEntries.push({
              type: 'SABR_CONTEXT_UPDATE',
              data: {
                sabrContextUpdate,
              },
            })
            if (!sabrContextUpdate) break

            if (sabrContextUpdate.type !== undefined && sabrContextUpdate.value?.length) {
              if (
                sabrContextUpdate.writePolicy === SabrContextWritePolicy.KEEP_EXISTING &&
                currentState.sabrStreamState.sabrContexts.has(sabrContextUpdate.type)
              ) {
                debugEntries.push(`Skipping SABR context update for type ${sabrContextUpdate.type}`)
                break
              }

              currentState.sabrStreamState.sabrContexts.set(sabrContextUpdate.type, sabrContextUpdate)

              if (sabrContextUpdate.sendByDefault) {
                currentState.sabrStreamState.activeSabrContextTypes.add(sabrContextUpdate.type)
              }

              debugEntries.push(`Received SABR context update (type: ${sabrContextUpdate.type}, sendByDefault: ${sabrContextUpdate.sendByDefault})`)
            }
            break
          }
          case UMPPartId.SABR_CONTEXT_SENDING_POLICY: {
            const sabrContextSendingPolicy = decodePart(part, SabrContextSendingPolicy)
            debugEntries.push({
              type: 'SABR_CONTEXT_SENDING_POLICY',
              data: {
                sabrContextSendingPolicy,
              },
            })
            if (!sabrContextSendingPolicy) break

            for (const startPolicy of sabrContextSendingPolicy.startPolicy) {
              if (!currentState.sabrStreamState.activeSabrContextTypes.has(startPolicy)) {
                currentState.sabrStreamState.activeSabrContextTypes.add(startPolicy)
                debugEntries.push(`Activated SABR context for type ${startPolicy}`)
              }
            }

            for (const stopPolicy of sabrContextSendingPolicy.stopPolicy) {
              if (currentState.sabrStreamState.activeSabrContextTypes.has(stopPolicy)) {
                currentState.sabrStreamState.activeSabrContextTypes.delete(stopPolicy)
                debugEntries.push(`Deactivated SABR context for type ${stopPolicy}`)
              }
            }

            for (const discardPolicy of sabrContextSendingPolicy.discardPolicy) {
              if (currentState.sabrStreamState.sabrContexts.has(discardPolicy)) {
                currentState.sabrStreamState.sabrContexts.delete(discardPolicy)
                debugEntries.push(`Discarded SABR context for type ${discardPolicy}`)
              }
            }
            break
          }
          case UMPPartId.RELOAD_PLAYER_RESPONSE: {
            const reloadPlaybackContext = decodePart(part, ReloadPlaybackContext)
            if (!reloadPlaybackContext) break

            debugEntries.push({
              type: 'RELOAD_PLAYER_RESPONSE',
              data: {
                reloadPlaybackContext,
              },
            })
            // Whole video cannot be played
            currentState.sabrStreamState.playerReloadRequested = true
            currentState.abortController.abort()
            currentState.eventEmitter.emit('reload', { reloadPlaybackContext })
            break
          }
          case UMPPartId.PLAYBACK_START_POLICY: {
            const playbackStartPolicy = decodePart(part, PlaybackStartPolicy)
            debugEntries.push({
              type: 'PLAYBACK_START_POLICY',
              data: {
                playbackStartPolicy,
              },
            })
            break
          }
          case UMPPartId.SNACKBAR_MESSAGE: {
            const snackbarMessage = decodePart(part, SnackbarMessage)
            debugEntries.push({
              type: 'SNACKBAR_MESSAGE',
              data: {
                snackbarMessage,
              },
            })
            break
          }
          case UMPPartId.REQUEST_CANCELLATION_POLICY: {
            const requestCancellationPolicy = decodePart(part, RequestCancellationPolicy)
            debugEntries.push({
              type: 'REQUEST_CANCELLATION_POLICY',
              data: {
                requestCancellationPolicy,
              },
            })
            break
          }
          case UMPPartId.SABR_ACK:
          case UMPPartId.CACHE_LOAD_POLICY: {
            debugEntries.push({
              type: 'CACHE_LOAD_POLICY',
              data: {},
            })
            break
          }
          default: {
            debugEntries.push({
              type: 'unhandled',
              data: part.type
            })
          }
        }
      })

      // debugEntries.push({
      //   type: 'whileLoopNearEnd',
      //   data: {
      //     abortStatus: currentState.abortStatus,
      //     remainingData,
      //   }
      // })
      if (!currentState.abortStatus.finished) {
        if (remainingData) {
          chunkedDataBuffer = remainingData.data
        } else {
          chunkedDataBuffer = null
        }

        readObj = await reader.read()
      }
    }
  } catch (error) {
    debugEntries.push({
      type: 'error',
      data: {
        abortStatus: currentState.abortStatus,
      }
    })
    if (currentState.abortStatus.cancelled) {
      throw createRecoverableNetworkError(ShakaError.Code.OPERATION_ABORTED, operationInputs.uri, operationInputs.requestType)
    } else if (currentState.abortStatus.timedOut) {
      throw createRecoverableNetworkError(ShakaError.Code.TIMEOUT, operationInputs.uri, operationInputs.requestType)
    } else if (!currentState.abortStatus.finished) {
      throw createRecoverableNetworkError(ShakaError.Code.HTTP_ERROR, operationInputs.uri, error, operationInputs.requestType)
    }
  }

  if (currentState.abortStatus.cancelled) {
    debugEntries.push({
      type: 'cancelled',
      data: {
        abortStatus: currentState.abortStatus,
      }
    })
    throw createRecoverableNetworkError(ShakaError.Code.OPERATION_ABORTED, operationInputs.uri, operationInputs.requestType)
  } else if (currentState.abortStatus.timedOut) {
    debugEntries.push({
      type: 'timedOut',
      data: {
        abortStatus: currentState.abortStatus,
      }
    })
    throw createRecoverableNetworkError(ShakaError.Code.TIMEOUT, operationInputs.uri, operationInputs.requestType)
  }

  if (responseDataChunks.length > 0 && segmentComplete) {
    const data = /** @__NOINLINE__ */ concatenateChunks(responseDataChunks)

    if (operationInputs.isInit) {
      currentState.initDataCache.set(operationInputs.formatIdString, data)
    }

    /** @type {shaka.extern.Response} */
    return {
      uri: operationInputs.uri,
      originalUri: operationInputs.uri,
      data,
      status: response.status,
      headers: {},
      fromCache: false,
      originalRequest: operationInputs.request,
    }
  } else if (shouldRetry) {
    console.warn('shouldRetry', {
      abrRequest: currentState.abrRequest,
      invalidPoToken,
      parts,
      debugEntries,

      operationInputs,
      currentState,
    })

    const { sabrContexts, unsentSabrContexts } = prepareSabrContexts(currentState.sabrStreamState)

    currentState.abrRequest.streamerContext.sabrContexts = sabrContexts
    currentState.abrRequest.streamerContext.unsentSabrContexts = unsentSabrContexts

    let body

    try {
      body = VideoPlaybackAbrRequest.encode(currentState.abrRequest).finish()
    } catch (error) {
      console.error('Invalid VideoPlaybackAbrRequest data', currentState.abrRequest)
      throw error
    }

    currentState.requestInit = {
      body,
      method: 'POST',
      headers: {
        'content-type': 'application/x-protobuf',
        'accept-encoding': 'identity',
        accept: 'application/vnd.yt-ump',
      },
      signal: currentState.abortController.signal,
    }
    currentState.abortStatus.timedOut = false

    currentState.abortStatus.finished = false
    return doRequest(operationInputs, currentState)
  } else if (invalidPoToken) {
    throw new ShakaError(
      ShakaError.Severity.CRITICAL,
      ShakaError.Category.NETWORK,
      ShakaError.Code.HTTP_ERROR,
      operationInputs.uri,
      new Error('Invalid PO token'),
      operationInputs.requestType,
    )
  } else if (error) {
    throw createRecoverableNetworkError(
      ShakaError.Code.HTTP_ERROR,
      operationInputs.uri,
      new Error(error),
      operationInputs.requestType,
    )
  } else if (responseDataChunks.length > 0 && !segmentComplete) {
    console.warn('Incomplete segment, missing MEDIA_END part')
    console.warn('parts', parts)
    console.warn('debugEntries', debugEntries)
    throw createRecoverableNetworkError(
      ShakaError.Code.HTTP_ERROR,
      operationInputs.uri,
      new Error('Incomplete segment, missing MEDIA_END part'),
      operationInputs.requestType,
    )
  } else if (response.status === 200) {
    console.warn('Empty response, this should not happen')
    console.warn('parts', parts)
    console.warn('debugEntries', debugEntries)
    throw createRecoverableNetworkError(
      ShakaError.Code.HTTP_ERROR,
      operationInputs.uri,
      new Error('Empty response, this should not happen'),
      operationInputs.requestType,
    )
  } else {
    const severity = response.status === 401 || response.status === 403
      ? ShakaError.Severity.CRITICAL
      : ShakaError.Severity.RECOVERABLE

    throw new ShakaError(
      severity,
      ShakaError.Category.NETWORK,
      ShakaError.Code.BAD_HTTP_STATUS,
      operationInputs.uri,
      response.status,
      '',
      {},
      operationInputs.requestType,
      operationInputs.uri,
    )
  }
}

/**
 * @typedef SabrStream
 * @type {object}
 * @property {(cb: ({backoffMs: number}) => void) => void} onBackoffRequested
 * @property {(cb: ({reloadPlaybackContext: ReloadPlaybackContext}) => void) => void} onReload
 * @property {() => void | undefined} cleanup
 */
/**
 * @param {import('../../views/Watch/Watch').SabrData} sabrData
 * @param {() => shaka.Player} getPlayer
 * @param {() => shaka.extern.Manifest} getManifest
 * @param {import('vue').ComputedRef<number>} playerWidth
 * @param {import('vue').ComputedRef<number>} playerHeight
 * @return SabrStream
 */
export function setupSabrScheme(sabrData, getPlayer, getManifest, playerWidth, playerHeight) {
  const eventEmitter = new EventEmitterLike()

  /**
   * Caches the init data until the video ends
   * that way changing qualities and between audio and DASH
   * doesn't have to fetch the init data and segment index again
   * @type {Map<string, Uint8Array>}
   */
  const initDataCache = new Map()

  const poToken = base64ToU8(sabrData.poToken)
  const videoPlaybackUstreamerConfig = base64ToU8(sabrData.ustreamerConfig)
  const clientInfo = deepCopy(sabrData.clientInfo)

  /**
   * @typedef SabrStreamState
   * @type {object}
   * @property {number} durationMs
   * @property {number} requestNumber
   * @property {Set<number>} activeSabrContextTypes
   * @property {Map<number, SabrContextUpdate>} sabrContexts
   * @property {?NextRequestPolicy} nextRequestPolicy
   * @property {boolean} playerReloadRequested
   */
  /** @type {SabrStreamState} */
  const sabrStreamState = {
    durationMs: Infinity,
    requestNumber: 0,
    activeSabrContextTypes: new Set(),
    sabrContexts: new Map(),
    nextRequestPolicy: undefined,
    playerReloadRequested: false,
  }

  shaka.net.NetworkingEngine.registerScheme('sabr', (uri, request, requestType, _progressUpdated, headersReceived, _config) => {
    if (sabrStreamState.playerReloadRequested) {
      console.error('playerReloadRequested', {
        sabrStreamState,
      })
      throw new ShakaError(
        ShakaError.Severity.CRITICAL,
        ShakaError.Category.PLAYER,
        ShakaError.Code.CONTENT_NOT_LOADED,
        uri,
        new Error('Player Reload Requested'),
        requestType,
      )
    }

    // lazily fetch it as the variable is only set after setupSabrScheme is called
    // but it will definitely exist when we receive a request here.
    const player = getPlayer()
    const isAudioOnly = player.isAudioOnly()

    const url = new URL(request.uris[0])

    const isInit = url.searchParams.has('init')
    const formatIdString = url.searchParams.get('formatId')

    if (isInit && initDataCache.has(formatIdString)) {
      return /** @__NOINLINE__ */ createCacheResponse(uri, request, initDataCache.get(formatIdString))
    }

    const variantTracks = player.getVariantTracks()
    const activeVariant = variantTracks.find(track => track.active)

    const streamIsAudio = url.hostname === 'audio'
    const streamIsVideo = url.hostname === 'video'

    let audioFormatId
    let videoFormatId

    if (streamIsAudio) {
      audioFormatId = formatIdFromString(formatIdString)

      if (isAudioOnly) {
        // We need to specify a video format even for audio only otherwise we get an error response
        videoFormatId = formatIdFromString(url.searchParams.get('videoFormatId'))
      } else {
        videoFormatId = formatIdFromString((activeVariant ?? variantTracks[0]).originalVideoId)
      }
    } else if (streamIsVideo) {
      videoFormatId = formatIdFromString(formatIdString)

      // for the first fetching of the initial data there won't be an active variant
      // (shaka-player only sets it to active after it has fetched the init/segment data)
      if (activeVariant) {
        audioFormatId = formatIdFromString(activeVariant.originalAudioId)
      } else {
        const candidates = variantTracks.filter((track) => track.audioRoles.includes('main'))

        const probableAudioFormat = candidates.reduce((previous, current) => {
          return current.audioBandwidth >= previous.audioBandwidth ? current : previous
        }, candidates[0])

        audioFormatId = formatIdFromString(probableAudioFormat.originalAudioId)
      }
    }

    /** @type {Protos.BufferedRange[]} */
    const bufferedRanges = []

    if (!isInit && activeVariant) {
      /** @__NOINLINE__ */ fillBufferedRanges(player, getManifest(), isAudioOnly, bufferedRanges, activeVariant)
    }

    let playerTimeMs = 0

    if (url.searchParams.has('startTimeMs')) {
      playerTimeMs = parseInt(url.searchParams.get('startTimeMs'))
    }

    const drcEnabled = url.searchParams.has('drc') || !!(activeVariant && activeVariant.audioRoles.includes('drc'))

    const resolution = streamIsVideo ? parseInt(url.searchParams.get('resolution')) : undefined

    const { sabrContexts, unsentSabrContexts } = prepareSabrContexts(sabrStreamState)

    /** @type {VideoPlaybackAbrRequest} */
    const requestData = {
      clientAbrState: {
        bandwidthEstimate: Math.round(player.getStats().estimatedBandwidth),
        timeSinceLastManualFormatSelectionMs: streamIsVideo ? 0 : undefined,
        stickyResolution: resolution,
        lastManualSelectedResolution: resolution,
        playbackRate: player.getPlaybackRate(),
        enabledTrackTypesBitfield: streamIsAudio ? 1 : 0,
        drcEnabled,
        playerTimeMs,
        clientViewportWidth: playerWidth.value,
        clientViewportHeight: playerHeight.value,
        clientViewportIsFlexible: false
      },
      preferredAudioFormatIds: [audioFormatId],
      preferredVideoFormatIds: [videoFormatId],
      preferredSubtitleFormatIds: [],
      selectedFormatIds: isInit ? [] : [audioFormatId, videoFormatId],
      bufferedRanges,
      streamerContext: {
        poToken: poToken,
        clientInfo: clientInfo,
        sabrContexts,
        unsentSabrContexts,
        playbackCookie: sabrStreamState.nextRequestPolicy?.playbackCookie ? PlaybackCookie.encode(sabrStreamState.nextRequestPolicy.playbackCookie).finish() : undefined,
      },
      field1000: [],
      videoPlaybackUstreamerConfig,
    }

    let body

    try {
      body = VideoPlaybackAbrRequest.encode(requestData).finish()
    } catch (error) {
      console.error('Invalid VideoPlaybackAbrRequest data', requestData)
      throw error
    }

    const sequenceNumber = parseInt(url.searchParams.get('sq'))

    /**
     * Stores whatever state that should be updated across the whole "session"
     * @type {OperationInputs}
     */
    const opInputs = {
      uri,
      request,
      requestType,
      headersReceived,

      formatIdString,
      isInit,
      sequenceNumber,
    }

    const abortController = new AbortController()

    /** @type {RequestInit} */
    const init = {
      body,
      method: 'POST',
      headers: {
        'content-type': 'application/x-protobuf',
        'accept-encoding': 'identity',
        accept: 'application/vnd.yt-ump',
      },
      signal: abortController.signal,
    }

    /**
     * Stores whatever state that should be updated across the whole "session"
     * @type {AbortStatus}
     */
    const abortStatus = {
      cancelled: false,
      timedOut: false,
      finished: false,
    }

    const timeoutMs = request.retryParameters.timeout
    let timeoutController = null
    if (timeoutMs) {
      timeoutController = createTimeoutController(() => {
        console.warn('setTimeout reached, timeoutMs: ', timeoutMs)
        abortStatus.timedOut = true
        abortController.abort()
      }, timeoutMs)
    }

    /**
     * Stores whatever state that should be updated across the whole "session"
     * @type {CurrentState}
     */
    const currentState = {
      sabrUrl: sabrData.url,
      initDataCache,
      abrRequest: requestData,
      requestInit: init,
      abortStatus: abortStatus,
      abortController,
      sabrStreamState,
      timeoutController,
      eventEmitter,
    }

    const pendingRequest = doRequest(opInputs, currentState)

    const op = new AbortableOperation(pendingRequest, () => {
      abortStatus.cancelled = true
      abortController.abort()
      return Promise.resolve()
    })

    if (timeoutController) {
      op.finally(() => {
        timeoutController.clearTimeout()
      })
    }

    return op
  })

  const cleanup = () => {
    shaka.net.NetworkingEngine.unregisterScheme('sabr')
    initDataCache.clear()
  }

  return {
    onBackoffRequested(callback) {
      eventEmitter.on('backoff-requested', callback)
    },
    onReload(callback) {
      eventEmitter.on('reload', callback)
    },
    cleanup,
  }
}
