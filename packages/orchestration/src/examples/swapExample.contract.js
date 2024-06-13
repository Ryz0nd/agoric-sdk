import { StorageNodeShape } from '@agoric/internal';
import { TimerServiceShape } from '@agoric/time';
import { withdrawFromSeat } from '@agoric/zoe/src/contractSupport/zoeHelpers.js';
import { makeDurableZone } from '@agoric/zone/durable.js';
import { E, Far } from '@endo/far';
import { deeplyFulfilled } from '@endo/marshal';
import { M, objectMap } from '@endo/patterns';
import { provideAll } from '@agoric/zoe/src/contractSupport';
import { prepareRecorderKitMakers } from '@agoric/zoe/src/contractSupport/recorder.js';
import { makeOrchestrationFacade } from '../facade.js';
import { orcUtils } from '../utils/orc.js';
import { makeChainHub } from '../utils/chainHub.js';
import { prepareLocalChainAccountKit } from '../exos/local-chain-account-kit.js';

/**
 * @import {Orchestrator, IcaAccount, CosmosValidatorAddress} from '../types.js'
 * @import {TimerService} from '@agoric/time';
 * @import {LocalChain} from '@agoric/vats/src/localchain.js';
 * @import {Remote} from '@agoric/internal';
 * @import {OrchestrationService} from '../service.js';
 * @import {Baggage} from '@agoric/vat-data'
 * @import {NameHub} from '@agoric/vats';
 */

/** @type {ContractMeta<typeof start>} */
export const meta = {
  privateArgsShape: {
    agoricNames: M.remotable('agoricNames'),
    localchain: M.remotable('localchain'),
    orchestrationService: M.or(M.remotable('orchestration'), null),
    storageNode: StorageNodeShape,
    marshaller: M.remotable('marshaller'),
    timerService: M.or(TimerServiceShape, null),
  },
  upgradability: 'canUpgrade',
};
harden(meta);

// XXX copied from inter-protocol
// TODO move to new `@agoric/contracts` package when we have it
/**
 * @param {Brand} brand must be a 'nat' brand, not checked
 * @param {NatValue} [min]
 */
export const makeNatAmountShape = (brand, min) =>
  harden({ brand, value: min ? M.gte(min) : M.nat() });

/**
 * @param {ZCF} zcf
 * @param {{
 *   agoricNames: Remote<NameHub>;
 *   localchain: Remote<LocalChain>;
 *   orchestrationService: Remote<OrchestrationService>;
 *   storageNode: Remote<StorageNode>;
 *   timerService: Remote<TimerService>;
 *   marshaller: Marshaller;
 * }} privateArgs
 * @param {Baggage} baggage
 */
export const start = async (zcf, privateArgs, baggage) => {
  const { brands } = zcf.getTerms();

  const zone = makeDurableZone(baggage);

  const {
    agoricNames,
    localchain,
    orchestrationService,
    storageNode,
    timerService,
    marshaller,
  } = privateArgs;

  const chainHub = makeChainHub(agoricNames);
  const { makeRecorderKit } = prepareRecorderKitMakers(baggage, marshaller);
  const makeLocalChainAccountKit = prepareLocalChainAccountKit(
    zone,
    makeRecorderKit,
    zcf,
    timerService,
    chainHub,
  );
  const { accountsStorageNode } = await provideAll(baggage, {
    accountsStorageNode: () => E(storageNode).makeChildNode('accounts'),
  });

  const { orchestrate } = makeOrchestrationFacade({
    localchain,
    orchestrationService,
    storageNode: accountsStorageNode,
    timerService,
    zcf,
    zone,
    chainHub,
    makeLocalChainAccountKit,
    makeRecorderKit,
  });

  /** deprecated historical example */
  /**
   * @type {OfferHandler<
   *   unknown,
   *   { staked: Amount<'nat'>; validator: CosmosValidatorAddress }
   * >}
   */
  const swapAndStakeHandler = orchestrate(
    'LSTTia',
    { zcf },
    // eslint-disable-next-line no-shadow -- this `zcf` is enclosed in a membrane
    async (/** @type {Orchestrator} */ orch, { zcf }, seat, offerArgs) => {
      const { give } = seat.getProposal();

      const omni = await orch.getChain('omniflixhub');
      const agoric = await orch.getChain('agoric');

      const [omniAccount, localAccount] = await Promise.all([
        omni.makeAccount(),
        agoric.makeAccount(),
      ]);

      const omniAddress = omniAccount.getAddress();

      // deposit funds from user seat to LocalChainAccount
      const payments = await withdrawFromSeat(zcf, seat, give);
      await deeplyFulfilled(objectMap(payments, localAccount.deposit));
      seat.exit();

      // build swap instructions with orcUtils library
      const transferMsg = orcUtils.makeOsmosisSwap({
        destChain: 'omniflixhub',
        destAddress: omniAddress,
        amountIn: give.Stable,
        brandOut: /** @type {any} */ ('FIXME'),
        slippage: 0.03,
      });

      await localAccount
        .transferSteps(give.Stable, transferMsg)
        .then(_txResult =>
          omniAccount.delegate(offerArgs.validator, offerArgs.staked),
        )
        .catch(e => console.error(e));

      // XXX close localAccount?
      // return continuing inv since this is an offer?
    },
  );

  const makeSwapAndStakeInvitation = () =>
    zcf.makeInvitation(
      swapAndStakeHandler,
      'Swap for TIA and stake',
      undefined,
      harden({
        give: { Stable: makeNatAmountShape(brands.Stable, 1n) },
        want: {}, // XXX ChainAccount Ownable?
        exit: M.any(),
      }),
    );

  const publicFacet = Far('SwapAndStake Public Facet', {
    makeSwapAndStakeInvitation,
  });

  return harden({ publicFacet });
};
