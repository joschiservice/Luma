import { Fragment, isValidElement, type ReactNode } from 'react';

type RichInputs = Record<string, ReactNode>;

const marker = '\u0091';

/**
 * Renders a localized message whose placeholders hold elements, such as a link or bold count,
 * so translators can still move them within the sentence. Plain values pass through to the
 * message unchanged, which keeps numbers usable as plural selectors. The result is one inline
 * span, so flex and grid containers lay the sentence out as a single item.
 *
 * @example rich(m.pagination_page, { page: <strong>{formatNumber(3)}</strong>, total: 12 })
 */
export function rich<Inputs extends RichInputs>(
  message: (inputs: Inputs) => string,
  inputs: Inputs,
): ReactNode {
  const elements: ReactNode[] = [];
  const text = Object.fromEntries(
    Object.entries(inputs).map(([name, value]) => {
      if (!isValidElement(value) && !Array.isArray(value)) return [name, value];
      elements.push(value);

      return [name, `${marker}${elements.length - 1}${marker}`];
    }),
  ) as Inputs;

  return (
    <span>
      {message(text)
        .split(marker)
        .map((part, index) =>
          index % 2 === 1 ? (
            <Fragment key={index}>{elements[Number(part)]}</Fragment>
          ) : (
            part
          ),
        )}
    </span>
  );
}
