import { m } from '@luma/i18n/messages';
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
            aria-label={m.help_button_label()}
            title={m.help_button_label()}
          />
        }
      >
        <CircleHelp size={18} aria-hidden="true" />
      </DialogTrigger>
      <DialogContent className="help-drawer translate-x-0 translate-y-0">
        <div className="help-drawer-heading">
          <CircleHelp size={18} aria-hidden="true" />
          <DialogTitle>{m.common_help()}</DialogTitle>
          <DialogDescription className="sr-only">
            {m.help_drawer_description()}
          </DialogDescription>
        </div>
        {open ? (
          <CatchBoundary
            getResetKey={() => topic}
            errorComponent={() => (
              <div className="help-load-state" role="alert">
                {m.help_load_failed()}{' '}
                <a href={`/docs/${topic}`} target="_blank" rel="noreferrer">
                  {m.help_load_failed_link()}
                </a>
              </div>
            )}
          >
            <Suspense
              fallback={
                <div className="help-load-state" role="status">
                  {m.docs_article_loading()}
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
