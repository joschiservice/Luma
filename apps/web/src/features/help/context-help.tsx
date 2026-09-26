import { Button } from '@luma/ui/components/primitives/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from '@luma/ui/components/primitives/dialog';
import { CatchBoundary, useMatches } from '@tanstack/react-router';
import { CircleHelp } from 'lucide-react';
import { lazy, Suspense, useState } from 'react';

import { contextualTopic, type HelpTopic } from './context';

const HelpReader = lazy(() => import('./help-reader'));

/** Opens the guide assigned to the most specific active route, when one is available. */
export function ContextHelp() {
  const topic = useMatches({ select: contextualTopic });

  return topic ? <HelpButton key={topic} topic={topic} /> : null;
}

function HelpButton({ topic }: { topic: HelpTopic }) {
  const [open, setOpen] = useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            className="workspace-help"
            aria-label="Help for this page"
            title="Help for this page"
          />
        }
      >
        <CircleHelp size={18} aria-hidden="true" />
      </DialogTrigger>
      <DialogContent className="help-drawer translate-x-0 translate-y-0">
        <div className="help-drawer-heading">
          <CircleHelp size={18} aria-hidden="true" />
          <DialogTitle>Help</DialogTitle>
          <DialogDescription className="sr-only">
            Guides for the page you are working on.
          </DialogDescription>
        </div>
        {open ? (
          <CatchBoundary
            getResetKey={() => topic}
            errorComponent={() => (
              <div className="help-load-state" role="alert">
                We couldn’t load this guide.{' '}
                <a href={`/docs/${topic}`} target="_blank" rel="noreferrer">
                  Open documentation in a new tab
                </a>
                .
              </div>
            )}
          >
            <Suspense
              fallback={
                <div className="help-load-state" role="status">
                  Loading your guide…
                </div>
              }
            >
              <HelpReader topic={topic} />
            </Suspense>
          </CatchBoundary>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
