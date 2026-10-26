'use client';

import { useState, useCallback } from 'react';
import { MC } from '../../mapColors';
import type { RenderingConfig, RenderingPreset } from '@/types/api';
import type { BandSelection } from '../../types';
import { BandSelectRow } from './PanelControls';

interface BandSelectorProps {
  renderingConfig: RenderingConfig;
  bandSelection: BandSelection | null;
  activePreset: string | null;
  onBandChange: (bands: BandSelection, preset?: string | null) => void;
  onPresetChange: (presetId: string) => void;
  /** Lay the R/G/B pickers out in one row (used inside the AOI panel). */
  compact?: boolean;
}

const CHANNEL_LABELS = ['R', 'G', 'B'] as const;
const CHANNEL_COLORS = ['#e05c5c', '#5cb85c', '#5c8ce0'] as const;

export function BandSelector({
  renderingConfig,
  bandSelection,
  activePreset,
  onBandChange,
  onPresetChange,
  compact = false,
}: BandSelectorProps) {
  const bands = renderingConfig.bands;
  // Drop expression-based presets (e.g. legacy "ndvi"/"moisture" baked into
  // already-ingested datasets). `handlePresetChange` can't apply `expression`/
  // `asset_as_band`, so those buttons would render garbage. NDVI now lives in
  // Temporal Playback, which builds its own expression.
  const presets = Object.fromEntries(
    Object.entries(renderingConfig.presets).filter(
      ([, preset]) => !preset.params?.expression && !preset.params?.asset_as_band,
    ),
  );

  // Derive current selection — if no explicit selection, parse from default preset
  const current = bandSelection ?? deriveDefaultBands(renderingConfig);

  const handleChannelChange = useCallback(
    (channel: 'r' | 'g' | 'b', bandIndex: number) => {
      const updated = { ...current, [channel]: bandIndex };
      onBandChange(updated, null); // clear preset when manually selecting
    },
    [current, onBandChange],
  );

  const handlePresetClick = useCallback(
    (presetId: string) => {
      onPresetChange(presetId);
    },
    [onPresetChange],
  );

  if (bands.length < 2) return null; // No band selection needed for single-band

  return (
    <div>
      {/* Presets row */}
      {Object.keys(presets).length > 1 && (
        <div style={{ marginBottom: 8 }}>
          <div style={{
            fontSize: 10, fontWeight: 600, color: MC.textMuted,
            textTransform: 'uppercase', letterSpacing: '0.03em',
            marginBottom: 4,
          }}>
            Presets
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {Object.entries(presets).map(([pid, preset]) => (
              <PresetButton
                key={pid}
                presetId={pid}
                preset={preset}
                isActive={activePreset === pid}
                onClick={handlePresetClick}
              />
            ))}
          </div>
        </div>
      )}

      {/* RGB channel selectors */}
      <div style={{
        fontSize: 10, fontWeight: 600, color: MC.textMuted,
        textTransform: 'uppercase', letterSpacing: '0.03em',
        marginBottom: 4,
      }}>
        RGB Channels ({bands.length} bands)
      </div>
      <div style={compact
        ? { display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 6 }
        : { display: 'flex', flexDirection: 'column', gap: 4 }}>
        {CHANNEL_LABELS.map((ch, i) => {
          const channel = ch.toLowerCase() as 'r' | 'g' | 'b';
          const selectedIndex = current[channel];
          return (
            <BandSelectRow
              key={ch}
              label={ch}
              color={CHANNEL_COLORS[i]}
              labelWidth={compact ? 10 : 16}
              bands={bands}
              value={selectedIndex}
              onChange={(idx) => handleChannelChange(channel, idx)}
            />
          );
        })}
      </div>
    </div>
  );
}

function PresetButton({
  presetId, preset, isActive, onClick,
}: {
  presetId: string;
  preset: RenderingPreset;
  isActive: boolean;
  onClick: (id: string) => void;
}) {
  const [hover, setHover] = useState(false);
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onClick(presetId); }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={preset.label}
      style={{
        padding: '3px 8px', borderRadius: 4,
        fontSize: 10, fontWeight: 600,
        background: isActive ? MC.accentDim : hover ? MC.hoverBg : 'transparent',
        border: `1px solid ${isActive ? MC.accent : MC.border}`,
        color: isActive ? MC.accent : MC.textSecondary,
        cursor: 'pointer',
        transition: 'all 0.12s',
        whiteSpace: 'nowrap',
      }}
    >
      {preset.label}
    </button>
  );
}

/** Parse default band selection from the rendering config's default preset */
function deriveDefaultBands(rc: RenderingConfig): BandSelection {
  const defaultPreset = rc.presets[rc.default_preset];
  if (defaultPreset?.params?.asset_bidx) {
    const match = defaultPreset.params.asset_bidx.match(/\|(\d+),(\d+),(\d+)/);
    if (match) {
      return { r: Number(match[1]), g: Number(match[2]), b: Number(match[3]) };
    }
  }
  // Fallback: first 3 bands
  return {
    r: rc.bands[0]?.index ?? 1,
    g: rc.bands[1]?.index ?? 2,
    b: rc.bands[2]?.index ?? 3,
  };
}
