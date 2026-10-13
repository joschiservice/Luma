import type { ProviderContext } from '@luma/simulator-core';

/** A synthetic Starshipit account; credentials are checked for presence only. */
export interface StarshipitConfig {
  name: string;
}

export type StarshipitContext = ProviderContext<StarshipitConfig>;

/** Provider items retain arbitrary fields so full-order updates preserve original values. */
export interface StarshipitItem {
  item_id: number;
  sku: string;
  description: string;
  quantity: number;
  quantity_to_ship?: number;
  weight: number;
  value: number;
}

/** One parcel's explicit item quantities and carrier evidence. */
export interface StarshipitPackage {
  package_id: number;
  tracking_number: string;
  tracking_url: string;
  carrier: string;
  items: { item_id: number; quantity: number }[];
  status: string;
  shipment_date: string;
  last_updated_date: string;
  tracking_events: {
    status: string;
    description: string;
    event_date: string;
  }[];
}

/** Independent provider order, without inferred links to another commerce system. */
export interface StarshipitOrder {
  order_id: number;
  order_number: string;
  order_date: string;
  last_updated_date: string;
  status: 'Unshipped' | 'Printed' | 'Shipped';
  items: StarshipitItem[];
  packages: StarshipitPackage[];
  destination: Record<string, string>;
}
