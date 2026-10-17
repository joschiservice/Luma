import { adaptiveContract } from '../contracts/adaptive.js';
import { adaptiveActionsContract } from '../contracts/adaptive-actions.js';
import { adaptiveFieldsContract } from '../contracts/adaptive-fields.js';
import { adaptivePackagesContract } from '../contracts/adaptive-packages.js';
import { adaptiveViewsContract } from '../contracts/adaptive-views.js';
import { collectionsContract } from '../contracts/collections.js';

/** Routes served by `@luma/adaptive`. */
type AdaptiveContracts = {
  adaptive: typeof adaptiveContract;
  adaptiveActions: typeof adaptiveActionsContract;
  adaptiveFields: typeof adaptiveFieldsContract;
  adaptivePackages: typeof adaptivePackagesContract;
  adaptiveViews: typeof adaptiveViewsContract;
  collections: typeof collectionsContract;
};

/** Routes served by `@luma/adaptive`, keyed by area. */
export const adaptiveContracts: AdaptiveContracts = {
  adaptive: adaptiveContract,
  adaptiveActions: adaptiveActionsContract,
  adaptiveFields: adaptiveFieldsContract,
  adaptivePackages: adaptivePackagesContract,
  adaptiveViews: adaptiveViewsContract,
  collections: collectionsContract,
};
