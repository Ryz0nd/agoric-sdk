/* global process */

import test from 'ava';

import {
  agd,
  agops,
  executeOffer,
  getVatDetails,
  GOV1ADDR,
  GOV2ADDR,
  GOV3ADDR,
  newOfferId,
} from '@agoric/synthetic-chain';

const ORACLE_ADDRESSES = [GOV1ADDR, GOV2ADDR, GOV3ADDR];

async function showOracleInstances() {
  const instanceRec = await agd.query(
    'vstorage',
    'data',
    '--output',
    'json',
    `published.agoricNames.instance`,
  );

  // agd query -o json  vstorage data published.agoricNames.instance
  //    |& jq '.value | fromjson | .values[1] | fromjson | .body[1:]
  //    | fromjson | .[-2] '
  const body = JSON.parse(JSON.parse(instanceRec.value).values[0]);
  const bodyTruncated = JSON.parse(body.body.substring(1));

  for (const rec of bodyTruncated) {
    if (rec[0].indexOf(`USD price feed`) > 0) {
      console.log(`PFt present`, rec);
    }
  }
}

async function getOracleInstance(price) {
  const instanceRec = await agd.query(
    'vstorage',
    'data',
    '--output',
    'json',
    `published.agoricNames.instance`,
  );

  // agd query -o json  vstorage data published.agoricNames.instance
  //    |& jq '.value | fromjson | .values[1] | fromjson | .body[1:]
  //    | fromjson | .[-2] '
  const body = JSON.parse(JSON.parse(instanceRec.value).values[0]);
  const bodyTruncated = JSON.parse(body.body.substring(1));
  const slots = body.slots;

  for (const [k, v] of bodyTruncated.entries()) {
    if (v[0] === `${price}-USD price feed`) {
      console.log(`PFt FOUND`, slots[k]);
      return slots[k];
    }
  }

  return null;
}

async function checkForOracle(t, name) {
  const instance = await getOracleInstance(name);
  console.log('PFt oInst', name, instance);
  // t.truthy(instance);
}

test.serial('check all priceFeed vats updated', async t => {
  await null;
  process.env.ORACLE_ADDRESSES = JSON.stringify(ORACLE_ADDRESSES);

  await showOracleInstances();

  const atomDetails = await getVatDetails('ATOM-USD_price_feed');
  // both the original and the new ATOM vault are incarnation 0
  t.is(atomDetails.incarnation, 0);
  const stAtomDetails = await getVatDetails('stATOM');
  t.is(stAtomDetails.incarnation, 0);
  const stOsmoDetails = await getVatDetails('stOSMO');
  console.log(`PFt osmo`, stOsmoDetails);
  t.is(stOsmoDetails.incarnation, 0);
  const stTiaDetails = await getVatDetails('stTIA');
  t.is(stTiaDetails.incarnation, 0);
  await checkForOracle(t, 'ATOM');
  await checkForOracle(t, 'stATOM');
  await checkForOracle(t, 'stTIA');
  await checkForOracle(t, 'stOSMO');
});

const oraclesByBrand = new Map();

const addOraclesForBrand = async brandIn => {
  await null;
  const promiseArray = [];

  const oraclesWithID = [];
  for (const oracleAddress of ORACLE_ADDRESSES) {
    const offerId = await newOfferId();
    oraclesWithID.push({ address: oracleAddress, offerId });

    console.log(`PFt adding`, offerId, oracleAddress, brandIn);

    promiseArray.push(
      executeOffer(
        oracleAddress,
        agops.oracle('accept', '--offerId', offerId, `--pair ${brandIn}.USD`),
      ),
    );
  }
  oraclesByBrand.set(brandIn, oraclesWithID);

  console.log(`PFt added Os`);

  return Promise.all(promiseArray);
};

const pushPrices = (price = 10.0, brandIn) => {
  console.log(`ACTIONS pushPrice ${price} for ${brandIn}`);
  const promiseArray = [];

  for (const oracle of oraclesByBrand.get(brandIn)) {
    promiseArray.push(
      executeOffer(
        oracle.address,
        agops.oracle(
          'pushPriceRound',
          '--price',
          price,
          '--oracleAdminAcceptOfferId',
          oracle.offerId,
        ),
      ),
    );
  }

  return Promise.all(promiseArray);
};

async function getPriceQuote(price) {
  const priceQuote = await agd.query(
    'vstorage',
    'data',
    '--output',
    'json',
    `published.priceFeed.${price}-USD_price_feed`,
  );

  const body = JSON.parse(JSON.parse(priceQuote.value).values[0]);
  const bodyTruncated = JSON.parse(body.body.substring(1));
  return bodyTruncated.amountOut.value;
}

test.serial('push prices', async t => {
  // There are no old prices for the other currencies.
  const atomOutPre = await getPriceQuote('ATOM');
  console.log(`PFtest pre`, atomOutPre);
  t.is(atomOutPre, '+12010000');

  await addOraclesForBrand('ATOM');
  await addOraclesForBrand('stATOM');
  await addOraclesForBrand('stTIA');
  await addOraclesForBrand('stOSMO');

  console.log(`PFt  addedO`);
  await pushPrices(11.2, 'ATOM');
  await pushPrices(11.3, 'stTIA');
  await pushPrices(11.4, 'stATOM');
  await pushPrices(11.5, 'stOSMO');
  console.log(`PFt pushed`);

  // agd query -o json  vstorage data published.priceFeed.stOSMO-USD_price_feed |&
  //   jq '.value | fromjson | .values[0] | fromjson | .body[1:] | fromjson | .amountOut.value'
  const atomOut = await getPriceQuote('ATOM');
  console.log(`PFt atomOut`, atomOut);
  t.is(atomOut, '+11200000');
  const tiaOut = await getPriceQuote('stTIA');
  console.log(`PFt Tia`, tiaOut);
  t.is(tiaOut, '+11300000');
  const stAtomOut = await getPriceQuote('stATOM');
  t.is(stAtomOut, '+11400000');
  const osmoOut = await getPriceQuote('stOSMO');
  t.is(osmoOut, '+11500000');
});
