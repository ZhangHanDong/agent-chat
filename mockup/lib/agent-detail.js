import { runtimeStatusText } from './mock-data.js';

export const isOnDemand = (agent) => agent?.runner?.mode === 'on-demand';
const hasPane = (agent) => typeof agent?.tmux === 'string' && agent.tmux.trim().length > 0;

export function hasLivePane(agent, provenance) {
  return provenance === 'live' && !isOnDemand(agent) && hasPane(agent);
}

export function runnerAvailabilityLabel(runner, t) {
  return t(runner?.availability === 'ready' ? 'ag.runnerReady'
    : runner?.availability === 'unavailable' ? 'ag.runnerUnavailable' : 'ag.runnerUnknown');
}

export function runnerActivityLabel(runner, t) {
  const key = {
    idle: 'ag.runnerIdle', running: 'ag.runnerRunning', queued: 'ag.runnerQueued', parked: 'ag.runnerParked',
  }[runner?.activity];
  return t(key ?? 'ag.runnerActivityUnknown');
}

/** Readiness is permission to start a fresh process, not a resident process heartbeat. */
export function runtimeLabel(agent, t) {
  if (isOnDemand(agent)) {
    const activity = agent.runner.activity;
    if (activity === 'idle') return runnerAvailabilityLabel(agent.runner, t);
    return runnerActivityLabel(agent.runner, t);
  }
  if (agent?.alive === false || (agent?.online === false && agent?.healthy !== true)) return 'OFFLINE';
  if (agent?.activeNow === true) {
    return Number.isFinite(agent.activeDurationSec) ? runtimeStatusText(agent) : 'ACTIVE';
  }
  if (agent?.activeNow === false && (agent?.alive === true || agent?.online === true)) {
    return Number.isFinite(agent.idleDurationSec) ? runtimeStatusText(agent) : 'IDLE';
  }
  return t('ag.runtimeUnknown');
}

export function transportLabel(agent, t) {
  if (isOnDemand(agent)) return t('ag.onDemand');
  if (hasPane(agent)) return `TMUX · ${agent.tmux}`;
  if (agent?.transport === 'acp') return t('ag.noPane');
  return t('ag.transportUnknown');
}
