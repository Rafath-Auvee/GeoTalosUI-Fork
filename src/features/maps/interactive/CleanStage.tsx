'use client';

import { useEffect, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Check, ChevronLeft, ChevronRight, Trash2 } from 'lucide-react';
import { annotationSchemasApi } from '@/lib/api/annotation-schemas';
import { InfoTip, PanelSelect } from '../components/RightPanel/PanelControls';
import { MC } from '../mapColors';
import { maskSpanM } from './geo';
import { flyToMask } from './mapActions';
import { reviewQueue } from './selection';
import { SelectionTray } from './SelectionTray';
import { useInteractiveStore, visibleMasks } from './store';
import type { LabelClass } from './types';
import { Button, Chip, Section, note } from './ui';
import { useThumbs } from './useThumbs';

const FILTERS = [
  { id: 'unusual', label: 'Unusual', hint: 'Masks that look odd for their group, or unlike your examples' },
  { id: 'unlabelled', label: 'Unlabelled', hint: 'Masks that still have no class' },
] as const;

const fmtM = (m: number) => (m >= 100 ? `${Math.round(m)}` : m >= 10 ? m.toFixed(0) : m.toFixed(1));
const classColor = (c: { style: { definition: { fillColor?: string } } | null }): string => c.style?.definition?.fillColor ?? MC.accent;

/**
 * Clean: give masks their class, then look at the doubtful ones one at a time.
 * Choose the class once under "Label with" and apply it to any selection made in
 * Group or here (a clicked mask, a size band, a look group); review walks the
 * unusual or unlabelled masks with Keep / Delete.
 */
export function CleanStage() {
  const masks = useInteractiveStore((s) => s.masks);
  const strictness = useInteractiveStore((s) => s.strictness);
  const scaleHidden = useInteractiveStore((s) => s.scaleHidden);
  const schemaId = useInteractiveStore((s) => s.labelSchemaId);
  const classId = useInteractiveStore((s) => s.labelClassId);
  const classes = useInteractiveStore((s) => s.classes);
  const review = useInteractiveStore((s) => s.review);
  const clusters = useInteractiveStore((s) => s.group.clusters);
  const geomView = useInteractiveStore((s) => s.geomView);
  const target = useInteractiveStore((s) => s.target);
  const st = useInteractiveStore.getState;

  const { data: schemasResp, isLoading } = useQuery({
    queryKey: ['interactive-schemas'],
    queryFn: () => annotationSchemasApi.list(100, 0),
  });
  const schemas = schemasResp?.items ?? [];
  const schema = schemas.find((s) => s.id === schemaId);
  // A schema's classes are a separate call: the schema list doesn't carry them (the same call the
  // map and annotation tools use, so these are exactly the classes models predict and people annotate with).
  const { data: classesResp, isLoading: loadingClasses } = useQuery({
    queryKey: ['interactive-schema-classes', schemaId],
    queryFn: () => annotationSchemasApi.getClasses(schemaId as string),
    enabled: !!schemaId,
  });
  const schemaClasses: LabelClass[] = useMemo(
    () => (classesResp?.items ?? []).map((c) => ({ id: c.id, name: c.name, color: classColor(c), schemaId: c.schema_id })),
    [classesResp],
  );
  const labelClass = schemaClasses.find((c) => c.id === classId) ?? null;

  const inPlay = visibleMasks(masks, strictness, scaleHidden);
  const unlabelled = inPlay.filter((m) => !m.classId);
  const queue = useMemo(() => reviewQueue(inPlay, review.filter), [inPlay, review.filter]);
  const index = Math.min(review.index, Math.max(0, queue.length - 1));
  const current = queue[index] ?? null;
  const thumbs = useThumbs(current ? [current] : []);
  const cluster = current?.clusterId !== null && current ? clusters.find((c) => String(c.index) === current.clusterId) : undefined;

  // Reviewing a mask selects it (so it shows in the bottom viewer) and brings it into view.
  const currentId = current?.id ?? null;
  useEffect(() => {
    if (!currentId) return;
    const m = useInteractiveStore.getState().masks.find((x) => x.id === currentId);
    useInteractiveStore.setState((s) => ({ selection: { ...s.selection, picked: [currentId] } }));
    if (m) flyToMask(m.geometry);
  }, [currentId]);

  const go = (delta: number) => st().setReviewIndex(Math.max(0, Math.min(queue.length - 1, index + delta)));
  const labelled = inPlay.length - unlabelled.length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <Section
        label="Show on the map"
        right={<InfoTip text="Give masks their class and check the doubtful ones. Whatever is left after this stage is treated as verified and is saved, so label or delete anything that isn't right. Every annotation is saved with both its mask and its box, so the view only changes what you see." />}
      >
        <div role="group" aria-label="Show masks as outlines or boxes" style={{ display: 'flex', gap: 6 }}>
          <Chip on={geomView === 'mask'} onClick={() => st().setGeomView('mask')} title="The exact outline SAM found">Mask outlines</Chip>
          <Chip on={geomView === 'box'} onClick={() => st().setGeomView('box')} title="The bounding box of each mask, as used to train detectors">Bounding boxes</Chip>
        </div>
      </Section>

      {/* Cleaning a set: its masks already have classes, so this only appears for masks that still need one. */}
      {(!target || unlabelled.length > 0) && (
        <Section
          label="Label with"
          right={
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <span style={{ ...note, fontVariantNumeric: 'tabular-nums' }}>{labelled} of {inPlay.length} labelled</span>
              <InfoTip text="Select masks in the Group stage, by clicking them on the map, or in the review below, then use the Label button at the bottom." />
            </span>
          }
        >
          {isLoading ? (
            <p style={note}>Loading schemas…</p>
          ) : (
            <>
              {!target && (
                <PanelSelect aria-label="Annotation schema" value={schemaId ?? ''} onChange={(e) => st().setLabelSchema(e.target.value || null)}>
                  <option value="">Choose a schema…</option>
                  {schemas.map((sc) => <option key={sc.id} value={sc.id}>{sc.name}</option>)}
                </PanelSelect>
              )}
              <PanelSelect aria-label="Class to apply" disabled={!schema || loadingClasses} value={classId ?? ''} onChange={(e) => st().setLabelClass(e.target.value || null, schemaClasses.find((c) => c.id === e.target.value) ?? null)}>
                <option value="">{!schema ? 'Choose a schema first' : loadingClasses ? 'Loading classes…' : schemaClasses.length === 0 ? 'This schema has no classes' : 'Choose a class…'}</option>
                {schemaClasses.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </PanelSelect>
            </>
          )}
          <Button
            disabled={!labelClass || unlabelled.length === 0}
            onClick={() => st().assignToSelectionOrUnlabelled(labelClass)}
            title="Applies the class to every mask that has none yet"
          >
            {labelClass ? `Label all ${unlabelled.length} unlabelled as ${labelClass.name}` : 'Label all unlabelled'}
          </Button>
        </Section>
      )}

      <Section
        label="Check doubtful masks"
        right={
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            {queue.length > 0 && <span style={{ ...note, fontVariantNumeric: 'tabular-nums' }}>{index + 1} of {queue.length}</span>}
            <InfoTip text="Click any mask on the map to look at it, Shift-click to add more. K keeps, D deletes, arrows move. Unusual masks come from grouping by look, or from masks that look unlike your examples." />
          </span>
        }
      >
        <div role="group" aria-label="Which masks to review" style={{ display: 'flex', gap: 6 }}>
          {FILTERS.map((f) => (
            <Chip key={f.id} on={review.filter === f.id} onClick={() => st().setReviewFilter(f.id)} title={f.hint}>{f.label}</Chip>
          ))}
        </div>

        {!current ? (
          <p style={note}>{review.filter === 'unusual' ? 'No unusual masks.' : 'Every mask has a class.'}</p>
        ) : (
          <div style={{ border: `1.5px solid ${MC.accent}`, borderRadius: 6, padding: 9, display: 'flex', flexDirection: 'column', gap: 8, background: MC.accentDim }}>
            <div style={{ display: 'flex', gap: 10 }}>
              <div style={{ width: 96, height: 96, flexShrink: 0, borderRadius: 5, overflow: 'hidden', background: MC.border }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                {thumbs[current.id] ? <img src={thumbs[current.id]} alt="The mask on the imagery" width={96} height={96} style={{ display: 'block', width: '100%', height: '100%', objectFit: 'cover' }} /> : null}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 3, fontSize: 11, color: MC.text, fontVariantNumeric: 'tabular-nums' }}>
                <span><b>{fmtM(maskSpanM(current.geometry))} m</b> across</span>
                <span style={note}>{Math.round(current.score * 100)}% sure · {current.scale_m} m scale</span>
                {cluster && <span style={note}>Group {cluster.name}</span>}
                <span style={note}>{current.classId ? `Labelled ${classes[current.classId]?.name ?? ''}` : 'Unlabelled'}</span>
                {current.flags.length > 0 && <span style={{ ...note, color: MC.danger }}>{current.flags.includes('suspect') ? 'Looks unlike your examples' : 'Unusual for its group'}</span>}
                {current.source === 'manual' && <span style={note}>One of your reference objects</span>}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              <Button icon={<ChevronLeft size={12} />} disabled={index === 0} onClick={() => go(-1)} title="Previous (←)">Prev</Button>
              <Button icon={<ChevronRight size={12} />} disabled={index >= queue.length - 1} onClick={() => go(1)} title="Next (→)">Next</Button>
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              <Button primary icon={<Check size={12} />} disabled={!current.classId && !labelClass} onClick={() => { st().keepMask(current.id); go(1); }} title={!current.classId && !labelClass ? 'Choose a class under “Label with” first: Keep labels this mask with it' : labelClass && !current.classId ? `Label it ${labelClass.name} and move on (K)` : "It's fine: stop flagging it and move on (K)"}>{labelClass && !current.classId ? `Keep as ${labelClass.name}` : 'Keep'}</Button>
              <Button icon={<Trash2 size={12} />} disabled={current.source === 'manual'} onClick={() => st().deleteMask(current.id)} title={current.source === 'manual' ? 'This is one of your reference objects. Remove it in the Propose stage.' : 'Remove this mask from the draft (D)'}>Delete</Button>
            </div>
          </div>
        )}
      </Section>

      <SelectionTray mode="clean" labelClass={labelClass} />
    </div>
  );
}
