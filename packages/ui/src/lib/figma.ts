/** Figma references for the implemented UI and its Storybook examples. */
export const figmaFiles = {
  designSystem: 'https://www.figma.com/design/FL0admcBfIIeypblAGGogm',
  product: 'https://www.figma.com/design/gAaPhosEb2613OeFbHO6Kg',
} as const;

export const figmaNodes = {
  foundationsLight: '5:27',
  foundationsDark: '5:30',
  button: '5:5',
  buttonPending: '25:38',
  input: '11:64',
  field: '12:54',
  dialog: '13:80',
  spinner: '7:2',
  sidebar: '18:40',
  shell: '22:53',
  navigationDrawer: '26:61',
} as const;

/** Returns the Storybook design reference for a shared Figma component. */
export function figmaDesign(node: keyof typeof figmaNodes) {
  return {
    type: 'figma' as const,
    url: `${figmaFiles.designSystem}?node-id=${figmaNodes[node].replace(':', '-')}`,
  };
}

export const figmaScreens = {
  desktop: '5:186',
  dark: '6:240',
  mobile: '6:271',
  navigationOpen: '6:304',
  longNames: '7:178',
  template: '7:209',
  issuesLight: '28:456',
  issuesDark: '28:630',
} as const;

/** Returns the Storybook design reference for a Figma product screen. */
export function figmaScreen(screen: keyof typeof figmaScreens) {
  return {
    type: 'figma' as const,
    url: `${figmaFiles.product}?node-id=${figmaScreens[screen].replace(':', '-')}`,
  };
}
