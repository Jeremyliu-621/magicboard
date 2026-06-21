import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Tldraw,
  createShapeId,
  getPointsFromDrawSegments,
  getSnapshot,
  loadSnapshot,
  renderPlaintextFromRichText,
  toRichText,
} from 'tldraw'

const DEFAULT_BACKEND_PORT = '8000'
const SYNC_DEBOUNCE_MS = 120
const RECONNECT_DELAY_MS = 1000
const GAME_FRAME = { x: 0, y: 0, w: 1920, h: 1080 }
const FRAME_SHAPE_ID = createShapeId('magicboard-stage-frame')
const EMPTY_STAGE_REFERENCE = { view: { w: GAME_FRAME.w, h: GAME_FRAME.h }, platforms: [], portals: [], spawns: [] }

const SIZE_TO_WIDTH = {
  s: 3,
  m: 6,
  l: 10,
  xl: 16,
}

const COLOR_TO_HEX = {
  black: '#2f2a26',
  grey: '#6b6259',
  lightBlue: '#5b8fcf',
  blue: '#2f6fe0',
  green: '#3f8f86',
  yellow: '#b58a2e',
  orange: '#d4663f',
  red: '#c0603a',
  lightRed: '#f28c78',
  violet: '#9a6cb0',
  purple: '#7c4e92',
  pink: '#d46aa4',
}

function getBackendUrl() {
  const params = new URLSearchParams(window.location.search)
  const configuredUrl = params.get('backend') || import.meta.env.VITE_BACKEND_URL
  if (configuredUrl) return configuredUrl

  const url = new URL(window.location.href)
  url.port = DEFAULT_BACKEND_PORT
  url.pathname = '/'
  url.search = ''
  url.hash = ''
  return url.toString()
}

function normalizeBackendUrl(rawUrl) {
  try {
    return new URL(rawUrl)
  } catch (_error) {
    return new URL(`http://localhost:${DEFAULT_BACKEND_PORT}`)
  }
}

function websocketUrlForRoom(backendUrl, roomId) {
  const url = new URL(backendUrl)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.pathname = `/ws/rooms/${encodeURIComponent(roomId)}`
  url.search = ''
  url.hash = ''
  return url.toString()
}

function captureUrlForRoom(backendUrl, roomId) {
  const url = new URL(backendUrl)
  url.pathname = `/rooms/${encodeURIComponent(roomId)}/capture`
  url.search = ''
  url.hash = ''
  return url.toString()
}

function clarificationUrlForRoom(backendUrl, roomId) {
  const url = new URL(backendUrl)
  url.pathname = `/rooms/${encodeURIComponent(roomId)}/clarifications`
  url.search = ''
  url.hash = ''
  return url.toString()
}

function visualObservationUrlForRoom(backendUrl, roomId) {
  const url = new URL(backendUrl)
  url.pathname = `/rooms/${encodeURIComponent(roomId)}/visual-observation`
  url.search = ''
  url.hash = ''
  return url.toString()
}

function voiceSessionsUrlForRoom(backendUrl, roomId) {
  const url = new URL(backendUrl)
  url.pathname = `/rooms/${encodeURIComponent(roomId)}/voice/sessions`
  url.search = ''
  url.hash = ''
  return url.toString()
}

function voiceSessionUrlForRoom(backendUrl, roomId, sessionId) {
  const url = new URL(backendUrl)
  url.pathname = `/rooms/${encodeURIComponent(roomId)}/voice/sessions/${encodeURIComponent(sessionId)}`
  url.search = ''
  url.hash = ''
  return url.toString()
}

function voiceWsUrlForRoom(backendUrl, roomId, sessionId) {
  const url = new URL(backendUrl)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.pathname = `/ws/rooms/${encodeURIComponent(roomId)}/voice/${encodeURIComponent(sessionId)}`
  url.search = ''
  url.hash = ''
  return url.toString()
}

function selectionWsUrlForBackend(backendUrl) {
  const url = new URL(backendUrl)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.pathname = '/ws/selection'
  url.search = ''
  url.hash = ''
  return url.toString()
}

function roomSelectionFromUrl() {
  const params = new URLSearchParams(window.location.search)
  const roomId = params.get('room')
  if (!roomId) return null
  return {
    roomId,
    worldId: params.get('world') || roomId,
    worldName: params.get('worldName') || null,
  }
}

function createClientId() {
  if (window.crypto?.randomUUID) return window.crypto.randomUUID()
  return `client-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function formatTime(value) {
  if (!value) return 'never'
  return new Date(value).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })
}

function colorFor(shape) {
  return COLOR_TO_HEX[shape?.props?.color] || '#d4663f'
}

function widthFor(shape) {
  return SIZE_TO_WIDTH[shape?.props?.size] || 6
}

function toGamePoint(x, y) {
  return {
    x: Math.round((x - GAME_FRAME.x) * 100) / 100,
    y: Math.round((y - GAME_FRAME.y) * 100) / 100,
  }
}

function richTextToPlain(editor, richText) {
  if (!richText) return ''
  try {
    return renderPlaintextFromRichText(editor, richText)
  } catch (_error) {
    return ''
  }
}

function makeProjection(editor, capture) {
  const records = Object.values(capture?.store || {})
  const strokes = []
  const shapes = []
  const labels = []

  for (const record of records) {
    if (record?.typeName !== 'shape' || record?.meta?.magicboardSystem) continue
    const common = {
      id: record.id,
      sourceId: record.id,
      color: colorFor(record),
      opacity: record.opacity ?? 1,
    }
    if (record.type === 'draw') {
      const points = getPointsFromDrawSegments(
        record.props.segments || [],
        record.props.scaleX || record.props.scale || 1,
        record.props.scaleY || record.props.scale || 1,
      ).map((point) => toGamePoint(record.x + point.x, record.y + point.y))
      if (points.length >= 2) {
        strokes.push({
          ...common,
          kind: 'freehand',
          points,
          width: widthFor(record),
        })
      }
    } else if (record.type === 'geo') {
      const x = record.x - GAME_FRAME.x
      const y = record.y - GAME_FRAME.y
      const w = record.props.w || 0
      const h = record.props.h || 0
      shapes.push({
        ...common,
        kind: record.props.geo || 'rectangle',
        x: Math.round(x * 100) / 100,
        y: Math.round(y * 100) / 100,
        w: Math.round(w * 100) / 100,
        h: Math.round(h * 100) / 100,
        width: widthFor(record),
      })
      const text = richTextToPlain(editor, record.props.richText).trim()
      if (text) {
        labels.push({
          ...common,
          text,
          x: Math.round((x + w / 2) * 100) / 100,
          y: Math.round((y + h / 2) * 100) / 100,
        })
      }
    } else if (record.type === 'text' || record.type === 'note') {
      const text = richTextToPlain(editor, record.props.richText).trim()
      if (text) {
        labels.push({
          ...common,
          text,
          x: Math.round((record.x - GAME_FRAME.x) * 100) / 100,
          y: Math.round((record.y - GAME_FRAME.y) * 100) / 100,
        })
      }
    }
  }

  return {
    type: 'magicboard_projection',
    version: 1,
    coordinateSpace: { type: 'game_view', width: GAME_FRAME.w, height: GAME_FRAME.h },
    strokes,
    shapes,
    labels,
    generatedAt: new Date().toISOString(),
  }
}

function projectionObjectCount(projection) {
  return (projection?.strokes?.length || 0) + (projection?.shapes?.length || 0) + (projection?.labels?.length || 0)
}

function semanticCandidateCount(semanticDraft) {
  return semanticDraft?.candidates?.length || 0
}

function visualObservationLabel(observation) {
  if (!observation) return 'waiting'
  if (observation.status === 'pending') return 'observing'
  if (observation.status === 'ready') return observation.latencyMs ? `ready · ${observation.latencyMs}ms` : 'ready'
  if (observation.status === 'missing_key') return 'missing key'
  if (observation.status === 'stale') return 'stale'
  return 'error'
}

function choiceLabel(choice) {
  const labels = {
    yes_platform: 'Solid',
    normal: 'Solid',
    pass_through: 'Pass-through',
    bouncy: 'Bouncy',
    damaging: 'Damaging',
    icy: 'Icy',
    breakable: 'Breakable',
    cannon: 'Cannon',
    decor: 'Decoration',
    no_ignore: 'Ignore',
  }
  return labels[choice?.id] || choice?.label || 'Choose'
}

function ensureStageFrame(editor) {
  if (!editor.getShape(FRAME_SHAPE_ID)) {
    editor.createShapes([
      {
        id: FRAME_SHAPE_ID,
        type: 'geo',
        x: GAME_FRAME.x,
        y: GAME_FRAME.y,
        isLocked: true,
        opacity: 0.55,
        meta: { magicboardSystem: true },
        props: {
          geo: 'rectangle',
          w: GAME_FRAME.w,
          h: GAME_FRAME.h,
          color: 'orange',
          fill: 'none',
          dash: 'dashed',
          size: 'm',
          font: 'draw',
          align: 'middle',
          verticalAlign: 'middle',
          richText: toRichText(''),
          labelColor: 'orange',
          url: '',
          growY: 0,
          scale: 1,
        },
      },
    ])
  }
  editor.zoomToBounds(GAME_FRAME, { inset: 80, animation: { duration: 120 } })
  editor.setCurrentTool('draw')
}

function platformClassName(platform) {
  const kind = platform.kind || (platform.pass ? 'float' : 'ground')
  return `reference-platform reference-platform-${kind}${platform.pass ? ' reference-platform-pass' : ''}`
}

function PlatformReferenceLayer({ stageReference }) {
  const reference = stageReference || EMPTY_STAGE_REFERENCE
  const view = reference.view || { w: GAME_FRAME.w, h: GAME_FRAME.h }
  const bounds = reference.bounds || { x0: 0, y0: 0, x1: view.w, y1: view.h }
  const platforms = reference.platforms || []
  const portals = reference.portals || []
  const spawns = reference.spawns || []

  return (
    <div
      className="platform-reference-frame"
      data-testid="static-platform-reference"
      aria-hidden="true"
    >
      <svg
        className="platform-reference-svg"
        viewBox={`0 0 ${view.w} ${view.h}`}
        width={view.w}
        height={view.h}
        focusable="false"
      >
        <rect className="reference-view-fill" x="0" y="0" width={view.w} height={view.h} />
        <rect className="reference-bounds" x={bounds.x0 || 0} y={bounds.y0 || 0} width={(bounds.x1 || view.w) - (bounds.x0 || 0)} height={(bounds.y1 || view.h) - (bounds.y0 || 0)} />
        {platforms.map((platform, index) => {
          const radius = Math.min(platform.h / 2, platform.pass ? 16 : 20)
          return (
            <g key={`${platform.x}-${platform.y}-${platform.w}-${platform.h}-${index}`}>
              <rect
                className="reference-platform-shadow"
                x={platform.x + 9}
                y={platform.y + 12}
                width={platform.w}
                height={platform.h}
                rx={radius}
                ry={radius}
              />
              <rect
                className={platformClassName(platform)}
                x={platform.x}
                y={platform.y}
                width={platform.w}
                height={platform.h}
                rx={radius}
                ry={radius}
              />
              <line
                className="reference-platform-topline"
                x1={platform.x + radius}
                y1={platform.y + Math.min(16, platform.h / 2)}
                x2={platform.x + platform.w - radius}
                y2={platform.y + Math.min(16, platform.h / 2)}
              />
            </g>
          )
        })}
        {portals.map((portal, index) => (
          <g key={`portal-${portal.id || index}`}>
            <circle className="reference-portal-fill" cx={portal.x} cy={portal.y} r={portal.r || 44} />
            <circle className="reference-portal-ring" cx={portal.x} cy={portal.y} r={portal.r || 44} />
          </g>
        ))}
        {spawns.map((spawn, index) => (
          <g key={`spawn-${index}`}>
            <circle className="reference-spawn" cx={spawn.x} cy={spawn.y} r="24" />
            <text className="reference-spawn-label" x={spawn.x} y={spawn.y + 8}>{index + 1}</text>
          </g>
        ))}
      </svg>
    </div>
  )
}

function SemanticCandidateLayer({ semanticDraft, selectedCandidateId }) {
  const candidates = semanticDraft?.candidates || []
  if (!candidates.length) return null

  return (
    <svg
      className="semantic-candidate-layer"
      viewBox={`${GAME_FRAME.x} ${GAME_FRAME.y} ${GAME_FRAME.w} ${GAME_FRAME.h}`}
      width={GAME_FRAME.w}
      height={GAME_FRAME.h}
      focusable="false"
      aria-hidden="true"
    >
      {candidates.map((candidate, index) => {
        const geometry = candidate.geometry || {}
        const selected = candidate.candidateId === selectedCandidateId
        const className = [
          'semantic-candidate',
          `semantic-candidate-${candidate.status || 'needs_answer'}`,
          selected ? 'semantic-candidate-selected' : '',
        ].filter(Boolean).join(' ')
        return (
          <g key={candidate.candidateId || `${candidate.geometryHash}-${index}`}>
            <rect
              className={className}
              x={geometry.x}
              y={geometry.y}
              width={geometry.w}
              height={geometry.h}
              rx={Math.min(18, Math.max(4, (geometry.h || 20) / 3))}
              ry={Math.min(18, Math.max(4, (geometry.h || 20) / 3))}
            />
            <text className="semantic-candidate-label" x={(geometry.x || 0) + 12} y={(geometry.y || 0) - 10}>
              {index + 1}
            </text>
          </g>
        )
      })}
    </svg>
  )
}

function SemanticPanel({
  semanticDraft,
  selectedCandidateId,
  onSelectCandidate,
  onAnswer,
  error,
}) {
  const candidates = semanticDraft?.candidates || []
  const pending = candidates.filter((candidate) => candidate.status === 'needs_answer')
  const current = candidates.find((candidate) => candidate.candidateId === selectedCandidateId)
  const selected = current?.status === 'needs_answer' ? current : pending[0] || current || candidates[0]
  if (!candidates.length) return null
  const question = selected?.question
  const choices = question?.choices || []
  const pendingCount = pending.length

  return (
    <section className="semantic-panel" aria-label="Agent asks">
      <div className="semantic-candidate-strip">
        {candidates.map((candidate, index) => (
          <button
            key={candidate.candidateId}
            className={`semantic-candidate-pill ${candidate.candidateId === selected?.candidateId ? 'active' : ''} status-${candidate.status || 'needs_answer'}`}
            type="button"
            onClick={() => onSelectCandidate(candidate.candidateId)}
          >
            {index + 1}
          </button>
        ))}
      </div>
      {selected ? (
        <div className="semantic-question">
          <div className="semantic-question-head">
            <div>
              <span>{pendingCount ? `Agent asks · ${pendingCount} left` : 'Agent state'}</span>
              <strong>{selected.status === 'needs_answer' ? question?.prompt || 'What should this platform do?' : selected.answer?.choiceId || selected.status}</strong>
            </div>
            <span>{selected.extractor}</span>
          </div>
          {selected.status === 'needs_answer' ? (
            <div className="semantic-choice-grid">
              {choices.map((choice) => (
                <button
                  key={choice.id}
                  type="button"
                  onClick={() => onAnswer(selected, choice.id)}
                >
                  {choiceLabel(choice)}
                </button>
              ))}
            </div>
          ) : (
            <p className="semantic-answer-state">
              {selected.answer?.role === 'platform' ? `Confirmed: ${selected.answer.behavior}` : selected.status}
            </p>
          )}
          {error ? <p className="semantic-error">{error}</p> : null}
        </div>
      ) : null}
    </section>
  )
}

function VisualObservationPanel({ observation }) {
  if (!observation) return null
  const hints = observation.hints || []
  return (
    <section className={`visual-observation-panel observation-${observation.status}`} aria-label="Visual observation">
      <div className="visual-observation-head">
        <strong>Vision</strong>
        <span>{visualObservationLabel(observation)}</span>
      </div>
      <p>{observation.description || 'Waiting for visual observation.'}</p>
      {hints.length ? (
        <ul>
          {hints.slice(0, 3).map((hint, index) => (
            <li key={`${hint.description}-${index}`}>
              {hint.kind} · {Math.round((hint.confidence || 0) * 100)}%
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  )
}

function VoicePanel({
  voiceStatus,
  voiceEvents,
  agentTurns,
  proposals,
  permissionRequests,
  isRecording,
  onToggleMic,
}) {
  const latestTranscript = [...voiceEvents].reverse().find((event) => event.type === 'final' || event.type === 'partial')
  const assistant = [...voiceEvents].reverse().find((event) => event.type === 'assistant_text')
  const proposal = [...proposals].reverse().find((item) => item.approvalState === 'pending_approval' || item.approvalState === 'approved') || proposals[proposals.length - 1]
  const permission = permissionRequests.find((item) => item.status === 'pending') || permissionRequests[permissionRequests.length - 1]
  const turn = agentTurns[agentTurns.length - 1]

  return (
    <section className="voice-panel" aria-label="Voice agent">
      <button className={`voice-mic ${isRecording ? 'recording' : ''}`} type="button" onClick={onToggleMic}>
        {isRecording ? 'Stop' : 'Mic'}
      </button>
      <div className="voice-sheet">
        <div className="voice-row">
          <strong>{voiceStatus || 'voice idle'}</strong>
          <span>{turn ? turn.status : 'no job'}</span>
        </div>
        <p>{latestTranscript?.transcript || assistant?.transcript || 'Transcript will appear here.'}</p>
        <div className="voice-chips">
          <span>{proposal ? `proposal · ${proposal.approvalState}` : 'no proposal'}</span>
          <span>{permission ? permission.status : 'no permission'}</span>
        </div>
      </div>
    </section>
  )
}

export default function App() {
  const backendUrl = useMemo(
    () => normalizeBackendUrl(getBackendUrl()),
    [],
  )
  const explicitRoom = useMemo(() => roomSelectionFromUrl(), [])
  const [selectedRoom, setSelectedRoom] = useState(explicitRoom)
  const roomId = selectedRoom?.roomId || ''
  const selectionWsUrl = useMemo(
    () => selectionWsUrlForBackend(backendUrl),
    [backendUrl],
  )
  const urls = useMemo(
    () => (roomId ? {
      capture: captureUrlForRoom(backendUrl, roomId),
      clarifications: clarificationUrlForRoom(backendUrl, roomId),
      visualObservation: visualObservationUrlForRoom(backendUrl, roomId),
      voiceSessions: voiceSessionsUrlForRoom(backendUrl, roomId),
      websocket: websocketUrlForRoom(backendUrl, roomId),
    } : null),
    [backendUrl, roomId],
  )

  const editorRef = useRef(null)
  const socketRef = useRef(null)
  const voiceSocketRef = useRef(null)
  const mediaRecorderRef = useRef(null)
  const micStreamRef = useRef(null)
  const reconnectTimerRef = useRef(null)
  const sendTimerRef = useRef(null)
  const cleanupStoreListenerRef = useRef(null)
  const mountedRef = useRef(false)
  const mountIdRef = useRef(0)
  const loadingCaptureRef = useRef(false)
  const pendingCaptureRef = useRef(false)
  const localHadUserContentRef = useRef(false)
  const userInteractedRef = useRef(false)
  const clientIdRef = useRef(createClientId())
  const previousSourceIdsRef = useRef(new Set())

  const [status, setStatus] = useState('idle')
  const [backendVersion, setBackendVersion] = useState('unknown')
  const [roomVersion, setRoomVersion] = useState(0)
  const [lastSyncedAt, setLastSyncedAt] = useState(null)
  const [projectionCount, setProjectionCount] = useState(0)
  const [semanticDraft, setSemanticDraft] = useState(null)
  const [visualObservation, setVisualObservation] = useState(null)
  const [selectedCandidateId, setSelectedCandidateId] = useState(null)
  const [semanticError, setSemanticError] = useState('')
  const [voiceSession, setVoiceSession] = useState(null)
  const [voiceEvents, setVoiceEvents] = useState([])
  const [agentTurns, setAgentTurns] = useState([])
  const [proposals, setProposals] = useState([])
  const [permissionRequests, setPermissionRequests] = useState([])
  const [voiceStatus, setVoiceStatus] = useState('voice idle')
  const [isRecording, setIsRecording] = useState(false)
  const [error, setError] = useState('')
  const [selectionStatus, setSelectionStatus] = useState(explicitRoom ? 'url room' : 'waiting')
  const tldrawComponents = useMemo(
    () => ({
      OnTheCanvas: () => (
        <>
          <PlatformReferenceLayer stageReference={selectedRoom?.stageReference} />
          <SemanticCandidateLayer semanticDraft={semanticDraft} selectedCandidateId={selectedCandidateId} />
        </>
      ),
    }),
    [semanticDraft, selectedCandidateId, selectedRoom?.stageReference],
  )

  useEffect(() => {
    const candidates = semanticDraft?.candidates || []
    setSelectedCandidateId((current) => {
      const selected = candidates.find((candidate) => candidate.candidateId === current)
      if (selected?.status === 'needs_answer') return current
      const pending = candidates.find((candidate) => candidate.status === 'needs_answer')
      if (pending) return pending.candidateId
      return selected?.candidateId || candidates[0]?.candidateId || null
    })
  }, [semanticDraft])

  useEffect(() => {
    let cancelled = false
    let socket = null
    let reconnectTimer = 0

    const applySelection = (selection, source) => {
      if (cancelled) return
      if (explicitRoom) {
        setSelectionStatus(source ? `url room · ${source}` : 'url room')
        setError('')
        setSelectedRoom(explicitRoom)
        return
      }
      if (selection.roomId) {
        setSelectionStatus(source || 'ready')
        setError('')
        setSelectedRoom((current) => {
          if (current?.roomId && current.roomId !== selection.roomId) {
            window.location.reload()
            return current
          }
          if (
            current?.roomId === selection.roomId
            && current?.worldId === selection.worldId
            && current?.worldName === selection.worldName
            && JSON.stringify(current?.stageReference || null) === JSON.stringify(selection.stageReference || null)
          ) {
            return current
          }
          return {
            roomId: selection.roomId,
            worldId: selection.worldId || selection.roomId,
            worldName: selection.worldName || null,
            stageReference: selection.stageReference || EMPTY_STAGE_REFERENCE,
          }
        })
      } else {
        setSelectionStatus('waiting')
        setSelectedRoom((current) => {
          if (current?.roomId) {
            window.location.reload()
            return current
          }
          return null
        })
      }
    }

    const connectSelectionSocket = () => {
      if (cancelled) return
      window.clearTimeout(reconnectTimer)
      setSelectionStatus((current) => (current === 'waiting' ? current : 'connecting'))
      socket = new WebSocket(selectionWsUrl)

      socket.addEventListener('open', () => {
        if (!cancelled) setSelectionStatus('listening')
      })

      socket.addEventListener('message', (event) => {
        let message
        try {
          message = JSON.parse(event.data)
        } catch (_error) {
          return
        }
        if (message.type === 'selection_hello' || message.type === 'selection_updated') {
          applySelection(message, message.type === 'selection_updated' ? 'updated' : 'listening')
        }
      })

      socket.addEventListener('close', () => {
        if (cancelled) return
        setSelectionStatus('reconnecting')
        reconnectTimer = window.setTimeout(connectSelectionSocket, RECONNECT_DELAY_MS)
      })

      socket.addEventListener('error', () => {
        if (!cancelled) setSelectionStatus('selection socket error')
      })
    }

    connectSelectionSocket()
    return () => {
      cancelled = true
      window.clearTimeout(reconnectTimer)
      socket?.close()
    }
  }, [explicitRoom, selectionWsUrl])

  useEffect(() => {
    setStatus(roomId ? 'idle' : 'waiting')
    setBackendVersion('unknown')
    setRoomVersion(0)
    setLastSyncedAt(null)
    setProjectionCount(0)
    setSemanticDraft(null)
    setVisualObservation(null)
    setSelectedCandidateId(null)
    setSemanticError('')
    setVoiceSession(null)
    setVoiceEvents([])
    setAgentTurns([])
    setProposals([])
    setPermissionRequests([])
    setVoiceStatus('voice idle')
    setIsRecording(false)
    localHadUserContentRef.current = false
    userInteractedRef.current = false
    previousSourceIdsRef.current = new Set()
  }, [roomId])

  const applyVoiceState = useCallback((message) => {
    if (Array.isArray(message.voiceSessions)) {
      setVoiceSession((current) => message.voiceSessions.find((session) => session.sessionId === current?.sessionId) || message.voiceSessions.find((session) => session.status !== 'ended') || current)
      const active = message.voiceSessions.find((session) => session.status !== 'ended')
      if (active) setVoiceStatus(`voice ${active.status}`)
    }
    if (Array.isArray(message.voiceEvents)) {
      setVoiceEvents((current) => {
        const byId = new Map(current.map((event) => [event.eventId, event]))
        message.voiceEvents.forEach((event) => byId.set(event.eventId, event))
        return Array.from(byId.values()).slice(-40)
      })
    }
    if (Array.isArray(message.agentTurns)) setAgentTurns(message.agentTurns)
    if (Array.isArray(message.proposals)) setProposals(message.proposals)
    if (Array.isArray(message.permissionRequests)) setPermissionRequests(message.permissionRequests)
  }, [])

  const activePendingCandidate = useMemo(() => {
    const candidates = semanticDraft?.candidates || []
    return candidates.find((candidate) => candidate.candidateId === selectedCandidateId && candidate.status === 'needs_answer')
      || candidates.find((candidate) => candidate.status === 'needs_answer')
      || null
  }, [semanticDraft, selectedCandidateId])

  useEffect(() => {
    if (!activePendingCandidate?.question?.prompt || !window.speechSynthesis) return
    const utterance = new SpeechSynthesisUtterance(activePendingCandidate.question.prompt)
    utterance.rate = 0.96
    utterance.pitch = 1
    window.speechSynthesis.cancel()
    window.speechSynthesis.speak(utterance)
    return () => {
      window.speechSynthesis?.cancel()
    }
  }, [activePendingCandidate?.questionId])

  const sendCaptureNow = useCallback(() => {
    const editor = editorRef.current
    const socket = socketRef.current
    if (!editor) return

    const { document } = getSnapshot(editor.store)
    const projection = makeProjection(editor, document)
    const objectCount = projectionObjectCount(projection)
    const sourceIds = new Set([
      ...(projection.strokes || []).map((item) => item.sourceId),
      ...(projection.shapes || []).map((item) => item.sourceId),
      ...(projection.labels || []).map((item) => item.sourceId),
    ].filter(Boolean))
    const changedSourceIds = [...sourceIds].filter((sourceId) => !previousSourceIdsRef.current.has(sourceId))
    previousSourceIdsRef.current = sourceIds
    setProjectionCount(objectCount)

    if (objectCount > 0) localHadUserContentRef.current = true
    if (objectCount === 0 && !localHadUserContentRef.current) {
      pendingCaptureRef.current = false
      return
    }

    if (!socket || socket.readyState !== WebSocket.OPEN) return

    pendingCaptureRef.current = false
    socket.send(
      JSON.stringify({
        type: 'canvas_capture',
        capture: document,
        projection,
        changedSourceIds,
        worldId: selectedRoom?.worldId || roomId,
        clientId: clientIdRef.current,
        sentAt: new Date().toISOString(),
      }),
    )
  }, [roomId, selectedRoom?.worldId])

  const sendClarificationAnswer = useCallback(async (candidate, choiceId) => {
    if (!candidate || !choiceId || !urls) return
    const payload = {
      type: 'clarification_answer',
      questionId: candidate.questionId,
      candidateId: candidate.candidateId,
      choiceId,
      captureVersion: candidate.captureVersion,
      sourceIds: candidate.sourceIds,
      geometryHash: candidate.geometryHash,
      worldId: selectedRoom?.worldId || roomId,
      clientId: clientIdRef.current,
    }
    setSemanticError('')
    const socket = socketRef.current
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(payload))
      return
    }
    try {
      const response = await fetch(urls.clarifications, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!response.ok) {
        const body = await response.json().catch(() => null)
        throw new Error(body?.detail || `Clarification failed: ${response.status}`)
      }
      setSemanticDraft(await response.json())
    } catch (requestError) {
      setSemanticError(requestError.message || 'Clarification failed.')
    }
  }, [roomId, selectedRoom?.worldId, urls])

  const scheduleCaptureSend = useCallback(() => {
    if (loadingCaptureRef.current) return
    if (!userInteractedRef.current) return
    pendingCaptureRef.current = true
    window.clearTimeout(sendTimerRef.current)
    sendTimerRef.current = window.setTimeout(sendCaptureNow, SYNC_DEBOUNCE_MS)
  }, [sendCaptureNow])

  const connectWebSocket = useCallback((mountId) => {
    window.clearTimeout(reconnectTimerRef.current)
    if (!mountedRef.current || mountIdRef.current !== mountId || !urls) return

    setStatus('connecting')
    const socket = new WebSocket(urls.websocket)
    socketRef.current = socket

    socket.addEventListener('open', () => {
      if (socketRef.current !== socket || mountIdRef.current !== mountId) return
      setStatus('connected')
      setError('')
      if (pendingCaptureRef.current) sendCaptureNow()
    })

    socket.addEventListener('message', (event) => {
      if (socketRef.current !== socket || mountIdRef.current !== mountId) return
      let message
      try {
        message = JSON.parse(event.data)
      } catch (_error) {
        return
      }

      if (message.type === 'hello') {
        setStatus('connected')
        setBackendVersion(message.backendVersion || 'unknown')
        setRoomVersion(message.version ?? 0)
        setSemanticDraft(message.semanticDraft || null)
        setVisualObservation(message.visualObservation || null)
        applyVoiceState(message)
      } else if (message.type === 'projection_updated') {
        setStatus('connected')
        setRoomVersion(message.version ?? 0)
        setLastSyncedAt(message.updatedAt || new Date().toISOString())
        setSemanticDraft(message.semanticDraft || null)
        setVisualObservation(message.visualObservation || null)
        applyVoiceState(message)
      } else if (message.type === 'semantic_draft_updated') {
        setStatus('connected')
        setRoomVersion(message.version ?? 0)
        setSemanticDraft(message.semanticDraft || null)
      } else if (message.type === 'visual_observation_updated') {
        setStatus('connected')
        setRoomVersion(message.version ?? 0)
        setVisualObservation(message.visualObservation || null)
        if (message.semanticDraft) setSemanticDraft(message.semanticDraft)
      } else if (message.type === 'voice_room_state_updated') {
        applyVoiceState(message)
      } else if (message.type === 'error') {
        setError(message.message || 'Backend rejected a message.')
        setSemanticError(message.message || 'Backend rejected a message.')
      }
    })

    socket.addEventListener('close', () => {
      if (socketRef.current !== socket || mountIdRef.current !== mountId) return
      socketRef.current = null
      if (!mountedRef.current || mountIdRef.current !== mountId) return
      setStatus('disconnected')
      reconnectTimerRef.current = window.setTimeout(() => connectWebSocket(mountId), RECONNECT_DELAY_MS)
    })

    socket.addEventListener('error', () => {
      if (socketRef.current !== socket || mountIdRef.current !== mountId) return
      setStatus('error')
    })
  }, [applyVoiceState, sendCaptureNow, urls])

  const stopVoice = useCallback(async (sendStop = true) => {
    if (sendStop && voiceSocketRef.current?.readyState === WebSocket.OPEN) {
      voiceSocketRef.current.send(JSON.stringify({ type: 'stop' }))
    }
    if (mediaRecorderRef.current) {
      try { mediaRecorderRef.current.stop() } catch (_error) {}
      mediaRecorderRef.current = null
    }
    if (micStreamRef.current) {
      micStreamRef.current.getTracks().forEach((track) => track.stop())
      micStreamRef.current = null
    }
    if (voiceSocketRef.current) {
      const socket = voiceSocketRef.current
      voiceSocketRef.current = null
      try { socket.close() } catch (_error) {}
    }
    if (voiceSession?.sessionId && urls) {
      fetch(voiceSessionUrlForRoom(backendUrl, roomId, voiceSession.sessionId), { method: 'DELETE' }).catch(() => {})
    }
    setIsRecording(false)
    setVoiceStatus('voice idle')
  }, [backendUrl, roomId, urls, voiceSession])

  const startVoice = useCallback(async () => {
    if (!urls || isRecording) return
    if (!navigator.mediaDevices || !window.MediaRecorder) {
      setVoiceStatus('mic unavailable')
      return
    }
    setVoiceStatus('voice starting')
    try {
      const response = await fetch(urls.voiceSessions, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId: clientIdRef.current, worldId: selectedRoom?.worldId || roomId }),
      })
      if (!response.ok) {
        const body = await response.json().catch(() => null)
        throw new Error(body?.detail?.message || `Voice failed: ${response.status}`)
      }
      const session = await response.json()
      setVoiceSession(session)
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      micStreamRef.current = stream
      const socket = new WebSocket(voiceWsUrlForRoom(backendUrl, roomId, session.sessionId))
      voiceSocketRef.current = socket
      socket.addEventListener('open', () => {
        const options = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? { mimeType: 'audio/webm;codecs=opus' } : undefined
        const recorder = new MediaRecorder(stream, options)
        mediaRecorderRef.current = recorder
        recorder.addEventListener('dataavailable', (event) => {
          if (event.data?.size && socket.readyState === WebSocket.OPEN) socket.send(event.data)
        })
        recorder.start(250)
        setIsRecording(true)
        setVoiceStatus('voice listening')
      })
      socket.addEventListener('close', () => {
        stopVoice(false)
      })
    } catch (requestError) {
      setVoiceStatus(requestError.message || 'voice error')
      stopVoice(false)
    }
  }, [backendUrl, isRecording, roomId, selectedRoom?.worldId, stopVoice, urls])

  const toggleVoice = useCallback(() => {
    if (isRecording) stopVoice()
    else startVoice()
  }, [isRecording, startVoice, stopVoice])

  const handleMount = useCallback(
    (editor) => {
      if (!urls) return undefined
      const mountId = mountIdRef.current + 1
      mountIdRef.current = mountId
      mountedRef.current = true
      editorRef.current = editor
      setStatus('loading')

      const loadInitialCapture = async () => {
        loadingCaptureRef.current = true
        try {
          const response = await fetch(urls.capture)
          if (!mountedRef.current || mountIdRef.current !== mountId) return
          if (!response.ok) throw new Error(`Capture request failed: ${response.status}`)
          const room = await response.json()
          if (!mountedRef.current || mountIdRef.current !== mountId) return
          setRoomVersion(room.version ?? 0)
          setSemanticDraft(room.semanticDraft || null)
          setVisualObservation(room.visualObservation || null)
          localHadUserContentRef.current = projectionObjectCount(room.projection) > 0

          if (room.capture) {
            loadSnapshot(editor.store, { document: room.capture })
          }
          ensureStageFrame(editor)
        } catch (requestError) {
          ensureStageFrame(editor)
          setError(requestError.message || 'Could not load backend capture.')
        } finally {
          if (!mountedRef.current || mountIdRef.current !== mountId) return
          loadingCaptureRef.current = false
          connectWebSocket(mountId)
        }
      }

      loadInitialCapture()

      cleanupStoreListenerRef.current = editor.store.listen(
        () => {
          scheduleCaptureSend()
        },
        { source: 'user', scope: 'document' },
      )

      return () => {
        mountedRef.current = false
        mountIdRef.current += 1
        window.clearTimeout(sendTimerRef.current)
        window.clearTimeout(reconnectTimerRef.current)
        pendingCaptureRef.current = false
        cleanupStoreListenerRef.current?.()
        cleanupStoreListenerRef.current = null
        socketRef.current?.close()
        socketRef.current = null
        stopVoice(false)
        editorRef.current = null
      }
    },
    [connectWebSocket, scheduleCaptureSend, stopVoice, urls],
  )

  if (!roomId) {
    return (
      <main className="draw-app draw-app-waiting">
        <section className="selection-wait-panel" aria-label="Desktop room selection">
          <h1>Waiting for desktop selection</h1>
          <p>Open a level on the desktop with Edit Level.</p>
          <dl>
            <div>
              <dt>Status</dt>
              <dd>{selectionStatus}</dd>
            </div>
            <div>
              <dt>Backend</dt>
              <dd>{backendUrl.toString()}</dd>
            </div>
          </dl>
          {error ? <p className="selection-error">{error}</p> : null}
        </section>
      </main>
    )
  }

  return (
    <main
      className="draw-app"
      onPointerDownCapture={() => { userInteractedRef.current = true }}
      onKeyDownCapture={() => { userInteractedRef.current = true }}
    >
      <Tldraw key={roomId} onMount={handleMount} components={tldrawComponents} />
      <aside className="editor-chrome" aria-label="Magic Board editor tools">
        <div className="editor-chrome-scroll">
          <SemanticPanel
            semanticDraft={semanticDraft}
            selectedCandidateId={selectedCandidateId}
            onSelectCandidate={setSelectedCandidateId}
            onAnswer={sendClarificationAnswer}
            error={semanticError}
          />
          <VisualObservationPanel observation={visualObservation} />
          <VoicePanel
            voiceStatus={voiceStatus}
            voiceEvents={voiceEvents}
            agentTurns={agentTurns}
            proposals={proposals}
            permissionRequests={permissionRequests}
            isRecording={isRecording}
            onToggleMic={toggleVoice}
          />
          <section className="debug-panel" aria-label="Sync status">
            <div className={`status-dot status-${status}`} />
            <dl>
              <div>
                <dt>Status</dt>
                <dd>{status}</dd>
              </div>
              <div>
                <dt>Room</dt>
                <dd>{roomId}</dd>
              </div>
              <div>
                <dt>World</dt>
                <dd>{selectedRoom?.worldName || selectedRoom?.worldId || 'selected'}</dd>
              </div>
              <div>
                <dt>Reference</dt>
                <dd>{`${selectedRoom?.stageReference?.platforms?.length || 0} platforms · ${selectedRoom?.stageReference?.portals?.length || 0} portals`}</dd>
              </div>
              <div>
                <dt>Backend</dt>
                <dd>{backendVersion}</dd>
              </div>
              <div>
                <dt>Version</dt>
                <dd>{roomVersion}</dd>
              </div>
              <div>
                <dt>Objects</dt>
                <dd>{projectionCount}</dd>
              </div>
              <div>
                <dt>Draft</dt>
                <dd>{semanticCandidateCount(semanticDraft)}</dd>
              </div>
              <div>
                <dt>Vision</dt>
                <dd>{visualObservationLabel(visualObservation)}</dd>
              </div>
              <div>
                <dt>Synced</dt>
                <dd>{formatTime(lastSyncedAt)}</dd>
              </div>
            </dl>
            {error ? <p>{error}</p> : null}
          </section>
        </div>
      </aside>
    </main>
  )
}
