/* global Buffer */

import { BlobReader, TextWriter, ZipReader } from '@zip.js/zip.js'; // @endo/zip was tried but doesn't provide compressedSize
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';

/** @import {Bundle} from '@agoric/swingset-vat'; */
/** @import {CoreEvalPlan} from '@agoric/deploy-script-support/src/writeCoreEvalParts.js' */

const PACKAGE_NAME_RE = /(?<packageName>.*-v[\d.]+)\//;

/**
 * @typedef CompartmentMap
 * @property {string[]} tags
 * @property {{compartment: string, module: string}} entry
 * @property {Record<string, {name: string, label: string, location: string, modules: Record<string, {compartment: string, module: string}>}} compartments
 */

/** @param {Bundle} bundleObj*/
export const extractBundleInfo = async bundleObj => {
  await null;
  if (bundleObj.moduleFormat === 'endoZipBase64') {
    const contents = Buffer.from(bundleObj.endoZipBase64, 'base64');
    const zipBlob = new Blob([contents], { type: 'application/zip' });

    const zipFileReader = new BlobReader(zipBlob);
    const writer = new TextWriter('utf-8');

    const zipReader = new ZipReader(zipFileReader);
    const entries = await zipReader.getEntries();
    await zipReader.close();

    assert(entries[0].filename, 'compartment-map.json');
    const cmapStr = await entries[0].getData(writer);
    /** @type {CompartmentMap} */
    const compartmentMap = JSON.parse(cmapStr);

    const fileSizes = Object.fromEntries(
      entries.map(e => [e.filename, e.compressedSize]),
    );

    return { compartmentMap, fileSizes };
  }
};

// UNTIL https://github.com/endojs/endo/issues/1656
/** @param {string} bundleFilename */
export const statBundle = async bundleFilename => {
  const bundle = fs.readFileSync(bundleFilename, 'utf8');
  /** @type {Bundle} */
  const bundleObj = JSON.parse(bundle);
  console.log('\nBUNDLE', bundleObj.moduleFormat, bundleFilename);

  const info = await extractBundleInfo(bundleObj);

  /** @type {Record<string, number>} */
  const byPackage = {};
  let totalSize = 0;
  for (const [filename, size] of Object.entries(info.fileSizes)) {
    totalSize += size;
    if (filename === 'compartment-map.json') {
      continue;
    }
    const { packageName } = filename.match(PACKAGE_NAME_RE).groups;
    byPackage[packageName] ||= 0;
    byPackage[packageName] += size;
  }

  console.log('Sum of compressed file sizes in each package:');
  console.table(byPackage);

  console.log('total size:', totalSize);
};

/** @param {string} path */
export const statPlans = async path => {
  const files = await fs.promises.readdir(path);
  const planfiles = files.filter(f => f.endsWith('plan.json'));

  for (const planfile of planfiles) {
    /** @type {CoreEvalPlan} */
    const plan = JSON.parse(fs.readFileSync(join(path, planfile), 'utf8'));
    console.log('\n**\nPLAN', plan.name);
    for (const bundle of plan.bundles) {
      await statBundle(bundle.fileName);
    }
  }
};
