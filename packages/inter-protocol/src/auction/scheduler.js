import { E } from '@endo/eventual-send';
import { TimeMath } from '@agoric/time';
import { Far } from '@endo/marshal';
import { makeTracer } from '@agoric/internal';
import { observeIteration, subscribeEach } from '@agoric/notifier';

import { AuctionState, makeCancelTokenMaker } from './util.js';
import {
  computeRoundTiming,
  nextDescendingStepTime,
  timeVsSchedule,
} from './scheduleMath.js';

const { details: X, Fail, quote: q } = assert;

const trace = makeTracer('SCHED');

// If the startAuction wakeup is no more than 5 minutes late, go ahead with it.
const MAX_LATE_TICK = 300n;

/**
 * @file The scheduler is presumed to be quiescent between auction rounds. Each
 * Auction round consists of a sequence of steps with decreasing prices. There
 * should always be a next schedule, but between rounds, liveSchedule is null.
 *
 * The lock period that the liquidators use might start before the previous
 * round has finished, so we need to schedule the next round each time an
 * auction starts. This means if the scheduling parameters change, it'll be a
 * full cycle before we switch. Otherwise, the vaults wouldn't know when to
 * start their lock period. If the lock period for the next auction hasn't
 * started when each aucion ends, we recalculate it, in case the parameters have
 * changed.
 *
 * If the clock skips forward (because of a chain halt, for instance), the
 * scheduler will try to cleanly and quickly finish any round already in
 * progress. It would take additional work on the manual timer to test this
 * thoroughly.
 */

const makeCancelToken = makeCancelTokenMaker('scheduler');

/**
 * @typedef {object} AuctionDriver
 * @property {() => void} reducePriceAndTrade
 * @property {() => void} finalize
 * @property {() => void} startRound
 * @property {() => void} lockPrices
 */

/**
 * @typedef {object} ScheduleNotification
 *
 * @property {Timestamp | null} activeStartTime start time of current
 *    auction if auction is active
 * @property {Timestamp | null} nextStartTime start time of next auction
 * @property {Timestamp | null} nextDescendingStepTime when the next descending step
 *    will take place
 */

const safelyComputeRoundTiming = (params, baseTime) => {
  trace('safelyComputeRoundTiming');
  try {
    return computeRoundTiming(params, baseTime);
  } catch (e) {
    console.error('🚨 No Next Auction', e);
    return null;
  }
};

/**
 * @param {AuctionDriver} auctionDriver
 * @param {import('@agoric/time/src/types').TimerService} timer
 * @param {Awaited<import('./params.js').AuctionParamManager>} params
 * @param {import('@agoric/time/src/types').TimerBrand} timerBrand
 * @param {import('@agoric/zoe/src/contractSupport/recorder.js').Recorder<ScheduleNotification>} scheduleRecorder
 * @param {StoredSubscription<GovernanceSubscriptionState>} paramUpdateSubscription
 */
export const makeScheduler = async (
  auctionDriver,
  timer,
  params,
  timerBrand,
  scheduleRecorder,
  paramUpdateSubscription,
) => {
  /**
   * live version is defined when an auction is active.
   *
   * @type {Schedule | null}
   */
  let liveSchedule = null;

  /** @returns {Promise<{ now: Timestamp, nextSchedule: Schedule | null }>} */
  const initializeNextSchedule = async () => {
    return E.when(
      // XXX manualTimer returns a bigint, not a timeRecord.
      E(timer).getCurrentTimestamp(),
      now => {
        const nextSchedule = safelyComputeRoundTiming(
          params,
          TimeMath.coerceTimestampRecord(now, timerBrand),
        );
        return { now, nextSchedule };
      },
    );
  };
  let { now, nextSchedule } = await initializeNextSchedule();
  const setTimeMonotonically = time => {
    TimeMath.compareAbs(time, now) >= 0 || Fail`Time only moves forward`;
    now = time;
  };

  const stepCancelToken = makeCancelToken();

  /** @type {typeof AuctionState[keyof typeof AuctionState]} */
  let auctionState = AuctionState.WAITING;

  /**
   * Publish the schedule. To be called after clockTick() (which processes a
   * descending step) or when the next round is scheduled.
   */
  const publishSchedule = () => {
    const sched = harden({
      activeStartTime: liveSchedule?.startTime || null,
      nextStartTime: nextSchedule?.startTime || null,
      nextDescendingStepTime: nextDescendingStepTime(
        liveSchedule,
        nextSchedule,
        now,
      ),
    });
    scheduleRecorder.write(sched);
  };

  /**
   * @param {Schedule | null} schedule
   */
  const clockTick = async schedule => {
    trace('clockTick', schedule?.startTime, now);
    if (!schedule) {
      return;
    }

    /** @type {() => Promise<void>} */
    const finishAuctionRound = () => {
      auctionState = AuctionState.WAITING;
      auctionDriver.finalize();

      trace(
        'finishAuctionRound start',
        Boolean(liveSchedule),
        Boolean(nextSchedule),
      );

      if (nextSchedule) {
        // only recalculate the next schedule at this point if the lock time has
        // not been reached.
        const nextLock = nextSchedule.lockTime;
        if (nextLock && TimeMath.compareAbs(now, nextLock) < 0) {
          const afterNow = TimeMath.addAbsRel(
            now,
            TimeMath.coerceRelativeTimeRecord(1n, timerBrand),
          );
          nextSchedule = safelyComputeRoundTiming(params, afterNow);
        }
      } else {
        console.warn(
          '🚨 finishAuctionRound without scheduling the next; reset with new auctioneer params',
        );
      }

      trace('finishAuctionRound clearing liveSchedule');
      liveSchedule = null;

      trace(
        'finishAuctionRound end',
        Boolean(liveSchedule),
        Boolean(nextSchedule),
      );

      trace('cancelling the PriceStepWaker');
      return E(timer).cancel(stepCancelToken);
    };

    const advanceRound = () => {
      if (auctionState === AuctionState.ACTIVE) {
        auctionDriver.reducePriceAndTrade();
      } else {
        auctionState = AuctionState.ACTIVE;
        try {
          auctionDriver.startRound();
          // This has been observed to fail because prices hadn't been locked.
          // This may be an issue about timing during chain start-up.
        } catch (e) {
          console.error(
            assert.error(
              'Unable to start auction cleanly. skipping this auction round.',
            ),
          );
          finishAuctionRound();

          return false;
        }
      }
      return true;
    };

    const phase = timeVsSchedule(now, schedule);
    trace('phase', phase);
    switch (phase) {
      case 'before':
        break;
      case 'during':
        advanceRound();
        break;
      case 'endExactly':
        if (advanceRound()) {
          await finishAuctionRound();
        }
        break;
      case 'after':
        await finishAuctionRound();
        break;
      default:
        Fail`invalid case`;
    }

    publishSchedule();
  };

  // XXX liveSchedule and nextSchedule are in scope
  // schedule the wakeups for the steps of this round
  const scheduleSteps = schedule => {
    schedule || Fail`liveSchedule not defined`;

    const { startTime } = schedule;
    trace('START ', startTime);

    const delayFromNow =
      TimeMath.compareAbs(startTime, now) > 0
        ? TimeMath.subtractAbsAbs(startTime, now)
        : TimeMath.subtractAbsAbs(startTime, startTime);

    trace('repeating', now, delayFromNow, startTime);

    void E(timer).repeatAfter(
      delayFromNow,
      schedule.clockStep,
      Far('PriceStepWaker', {
        wake(time) {
          trace('PriceStepWaker awoken', now);
          setTimeMonotonically(time);
          void clockTick(schedule);
        },
      }),
      stepCancelToken,
    );
  };

  // schedule a wakeup for the next round
  const scheduleNextRound = start => {
    trace(`nextRound`, start);
    void E(timer).setWakeup(
      start,
      Far('SchedulerWaker', {
        wake(time) {
          setTimeMonotonically(time);
          trace('SchedulerWaker awoken', time);
          // eslint-disable-next-line no-use-before-define
          return startAuction();
        },
      }),
    );
    publishSchedule();
  };

  // schedule a wakeup to lock prices
  const schedulePriceLock = lockTime => {
    trace(`priceLock`, lockTime);
    void E(timer).setWakeup(
      lockTime,
      Far('PriceLockWaker', {
        wake(time) {
          setTimeMonotonically(time);
          auctionDriver.lockPrices();
        },
      }),
    );
  };

  const relativeTime = t => TimeMath.coerceRelativeTimeRecord(t, timerBrand);

  const startAuction = async () => {
    !liveSchedule || Fail`can't start an auction round while one is active`;

    if (!nextSchedule) {
      console.error(
        assert.error(X`tried to start auction when none is scheduled`),
      );
      return;
    }

    // The clock tick may have arrived too late to trigger the next scheduled
    // round, for example because of a chain halt.  When this happens the oracle
    // quote may out of date and so must be ignored. Recover by returning
    // deposits and scheduling the next round. If it's only a little late,
    // continue with auction, just starting late.
    const nominalStart = TimeMath.subtractAbsRel(
      nextSchedule.startTime,
      nextSchedule.startDelay,
    );
    if (TimeMath.compareAbs(now, nominalStart) > 0) {
      const late = TimeMath.subtractAbsAbs(now, nominalStart);
      const maxLate = relativeTime(MAX_LATE_TICK);

      if (TimeMath.compareRel(late, maxLate) > 0) {
        console.warn(
          `Auction time jumped to ${q(now)} before next scheduled start ${q(
            nextSchedule.startTime,
          )}. Skipping that round.`,
        );
        nextSchedule = safelyComputeRoundTiming(params, now);
      } else {
        console.warn(`Auction started late by ${q(late)}. Starting ${q(now)}`);
      }
    }

    if (!nextSchedule) {
      // nothing new to schedule
      return;
    }
    // activate the nextSchedule as the live one
    // (read here and in function calls below)
    trace('startAuction filling liveSchedule');
    liveSchedule = nextSchedule;
    nextSchedule = safelyComputeRoundTiming(
      params,
      TimeMath.addAbsRel(liveSchedule.endTime, relativeTime(1n)),
    );

    scheduleSteps(liveSchedule);
    if (nextSchedule) {
      scheduleNextRound(
        TimeMath.subtractAbsRel(
          nextSchedule.startTime,
          nextSchedule.startDelay,
        ),
      );
      schedulePriceLock(nextSchedule.lockTime);
    } else {
      console.warn(
        'no nextSchedule so cannot schedule next round or price lock',
      );
    }
  };

  // initial setting:  firstStart is startDelay before next's startTime
  const startSchedulingFromScratch = () => {
    trace('startSchedulingFromScratch');
    if (nextSchedule) {
      const firstStart = TimeMath.subtractAbsRel(
        nextSchedule.startTime,
        nextSchedule.startDelay,
      );
      scheduleNextRound(firstStart);
      schedulePriceLock(nextSchedule.lockTime);
    }
  };
  startSchedulingFromScratch();

  // when auction parameters change, schedule a next auction if one isn't
  // already scheduled
  observeIteration(
    subscribeEach(paramUpdateSubscription),
    harden({
      async updateState(_newState) {
        trace('received param update');
        // if (!liveSchedule && !nextSchedule) {
        if (!nextSchedule) {
          ({ nextSchedule } = await initializeNextSchedule());
          startSchedulingFromScratch();
        }
      },
    }),
  );

  return Far('scheduler', {
    getSchedule: () => {
      trace('getSchedule returning', { liveSchedule, nextSchedule });
      return harden({
        liveAuctionSchedule: liveSchedule,
        nextAuctionSchedule: nextSchedule,
      });
    },
    getAuctionState: () => auctionState,
  });
};

/**
 * @typedef {object} Schedule
 * @property {import('@agoric/time/src/types').TimestampRecord} startTime
 * @property {import('@agoric/time/src/types').TimestampRecord} endTime
 * @property {NatValue} steps
 * @property {NatValue} endRate
 * @property {RelativeTime} startDelay
 * @property {RelativeTime} clockStep
 * @property {Timestamp} [lockTime]
 */

/**
 * @typedef {object} FullSchedule
 * @property {Schedule | null} nextAuctionSchedule
 * @property {Schedule | null} liveAuctionSchedule
 */
