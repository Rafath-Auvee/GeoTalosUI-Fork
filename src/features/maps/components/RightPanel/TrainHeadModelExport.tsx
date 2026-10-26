'use client';

import { useEffect, useRef, useState } from 'react';
import { IconButton, MenuItem, popoverStyle } from './PanelControls';
import { createPortal } from 'react-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { BookOpen, Check, Copy, Download, Loader2, MoreHorizontal, Repeat2, Trash2, X } from 'lucide-react';
import { dinoApi, type DinoFinetuneResult } from '@/lib/api/dino';
import { MC } from '../../mapColors';

const mb = (n: number | null | undefined) => (n == null ? '' : n >= 1e8 ? `${(n / 1e6).toFixed(0)} MB` : `${(n / 1e6).toFixed(1)} MB`);
const muted: React.CSSProperties = { fontSize: 13, color: MC.textMuted, margin: 0, lineHeight: 1.45 };

interface Spec {
  task: string;
  className: string;
  backbone: string;
  tileM: number | null;
  scoreMin: number;
  file: string;
}

/** Ready-to-run examples, filled in with this model's own numbers. */
function snippets(spec: Spec): { id: string; title: string; note: string; code: string }[] {
  const tile = spec.tileM ? `${spec.tileM} m` : 'the tile size it was trained on';
  if (spec.task === 'segment') {
    const tileM = spec.tileM ?? 10;
    return [
      {
        id: 'onnx', title: 'Python · ONNX Runtime',
        note: `pip install onnxruntime opencv-python pillow numpy. Cut tiles about ${tile} wide. The model returns foreground and boundary probabilities; the code below turns them into one outline per object, with its area.`,
        code: `import cv2
import numpy as np
import onnxruntime as ort
from PIL import Image

MODEL = "${spec.file}.onnx"
SIZE = 518           # fixed input size of the model
TILE_M = ${tileM}          # ground width of the tile it was trained on, in metres
THRESHOLD = ${spec.scoreMin}      # foreground probability that counts as the object
MIN_AREA = 40        # ignore specks smaller than this many pixels (in the ${'518'} px frame)

session = ort.InferenceSession(MODEL, providers=["CPUExecutionProvider"])  # or "CUDAExecutionProvider"


def segment(path: str):
    img = Image.open(path).convert("RGB")
    x = np.asarray(img.resize((SIZE, SIZE)), dtype=np.float32).transpose(2, 0, 1)[None] / 255.0  # RGB 0-1
    fg, edge = session.run(None, {"image": x})[0][0]      # (2, 518, 518): foreground and boundary probabilities

    mask = fg >= THRESHOLD
    core = (mask & (edge < 0.5)).astype(np.uint8)         # the object minus its edge: touching objects fall apart
    n, comp = cv2.connectedComponents(core)
    markers = np.zeros(fg.shape, np.int32)
    markers[~mask] = 1                                    # background
    for i in range(1, n):
        markers[comp == i] = i + 1                        # one marker per object
    gray = (255 * (1 - fg)).clip(0, 255).astype(np.uint8)
    cv2.watershed(cv2.cvtColor(gray, cv2.COLOR_GRAY2BGR), markers)   # grows each object back to its edge

    objects = []
    sx, sy = img.width / SIZE, img.height / SIZE          # back to the tile's own pixels
    for i in range(1, n):
        m = markers == i + 1
        if m.sum() < MIN_AREA:
            continue
        contours, _ = cv2.findContours(m.astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        ring = cv2.approxPolyDP(max(contours, key=cv2.contourArea), 1.0, True).reshape(-1, 2) * [sx, sy]
        area_m2 = m.sum() * (TILE_M / SIZE) ** 2
        objects.append({"score": float(fg[m].mean()), "area_m2": float(area_m2), "outline": ring.tolist()})
    return objects


objects = segment("tile.png")
print(f"${spec.className}: {len(objects)} objects")
for o in objects:
    print(f"  score {o['score']:.2f}  area {o['area_m2']:.2f} m2  {len(o['outline'])} outline points")
`,
      },
      {
        id: 'pt', title: 'Python · PyTorch (.pt)',
        note: 'The .pt holds only the trained decoder and pyramid. Rebuild the model with the platform code (SegmentModel in geoops-service/app/segment_model.py), which loads DINOv2 from Hugging Face.',
        code: `import torch

artifact = torch.load("${spec.file}.pt", map_location="cpu", weights_only=False)
print(artifact["kind"], artifact["backbone_key"])      # "segment", "${spec.backbone}"

# from app.segment_model import build_segment, predict_probs, masks_to_instances   # geoops-service/app/segment_model.py
# model = build_segment("${spec.backbone}")
# model.backbone.pyramid.load_state_dict(artifact["pyramid_state_dict"])
# model.head.load_state_dict(artifact["head_state_dict"])
# probs = predict_probs(model, image)                 # image: 3x518x518 tensor, RGB 0-1 -> (2, 518, 518)
# instances, scores = masks_to_instances(probs, ${spec.scoreMin})
`,
      },
    ];
  }
  if (spec.task === 'yolo') {
    const run = (ext: string) => `from ultralytics import YOLO

model = YOLO("${spec.file}.${ext}")          # the class names are stored inside the file
results = model.predict("tile.png", conf=${spec.scoreMin}, imgsz=640)

for box in results[0].boxes:
    x1, y1, x2, y2 = box.xyxy[0].tolist()   # pixels of tile.png
    name = results[0].names[int(box.cls)]
    print(f"{name}  {float(box.conf):.2f}  {x1:.0f} {y1:.0f} {x2:.0f} {y2:.0f}")
`;
    return [
      {
        id: 'onnx', title: 'Python · ONNX',
        note: `pip install ultralytics (AGPL-3.0). Cut tiles about ${tile} wide. It returns a box and a class name for every object it finds (${spec.className}).`,
        code: run('onnx'),
      },
      {
        id: 'pt', title: 'Python · PyTorch (.pt)',
        note: 'The .pt is the whole model, so it needs nothing else. Train further from it by choosing it under "Start from" in a new YOLO training, for example to add a class.',
        code: run('pt'),
      },
    ];
  }
  if (spec.task === 'classify') {
    return [
      {
        id: 'onnx', title: 'Python · ONNX Runtime',
        note: `pip install onnxruntime pillow numpy. Give it a tile about ${tile} wide; it returns the probability that ${spec.className} is in it.`,
        code: `import numpy as np
import onnxruntime as ort
from PIL import Image

MODEL = "${spec.file}.onnx"
SIZE = 518          # fixed input size of the model
THRESHOLD = ${spec.scoreMin}     # a tile counts as "${spec.className}" at or above this

session = ort.InferenceSession(MODEL, providers=["CPUExecutionProvider"])  # or "CUDAExecutionProvider"


def score(path: str) -> float:
    img = Image.open(path).convert("RGB").resize((SIZE, SIZE))
    x = np.asarray(img, dtype=np.float32).transpose(2, 0, 1)[None] / 255.0   # 1x3x518x518, RGB 0-1
    return float(session.run(None, {"image": x})[0][0])


p = score("tile.png")
print(f"{p:.3f}", "present" if p >= THRESHOLD else "absent")
`,
      },
      {
        id: 'pt', title: 'Python · PyTorch (.pt)',
        note: 'The .pt holds only the trained linear head. Rebuild the model with the platform code (ClassifyHead in geoops-service/app/classify_model.py), which loads DINOv2 from Hugging Face.',
        code: `import torch

artifact = torch.load("${spec.file}.pt", map_location="cpu", weights_only=False)
print(artifact["kind"], artifact["backbone_key"])      # "classify", "${spec.backbone}"

# model = ClassifyHead("${spec.backbone}")             # geoops-service/app/classify_model.py
# model.linear.load_state_dict(artifact["linear_state_dict"])
# model.eval()
# prob = torch.sigmoid(model(x))                       # x: 1x3x518x518, RGB 0-1
`,
      },
    ];
  }
  return [
    {
      id: 'onnx', title: 'Python · ONNX Runtime',
      note: `pip install onnxruntime pillow numpy. Cut tiles about ${tile} wide. Boxes come back in the 518 px frame, so scale them by tile width / 518.`,
      code: `import numpy as np
import onnxruntime as ort
from PIL import Image

MODEL = "${spec.file}.onnx"
SIZE = 518           # fixed input size of the model
SCORE_MIN = ${spec.scoreMin}     # drop weaker detections
IOU_MAX = 0.5        # merge boxes that overlap more than this

session = ort.InferenceSession(MODEL, providers=["CPUExecutionProvider"])  # or "CUDAExecutionProvider"


def nms(boxes, scores, iou_max):
    order = scores.argsort()[::-1]
    keep = []
    while order.size:
        i = order[0]
        keep.append(i)
        xx1 = np.maximum(boxes[i, 0], boxes[order[1:], 0])
        yy1 = np.maximum(boxes[i, 1], boxes[order[1:], 1])
        xx2 = np.minimum(boxes[i, 2], boxes[order[1:], 2])
        yy2 = np.minimum(boxes[i, 3], boxes[order[1:], 3])
        inter = np.clip(xx2 - xx1, 0, None) * np.clip(yy2 - yy1, 0, None)
        area = lambda b: (b[..., 2] - b[..., 0]) * (b[..., 3] - b[..., 1])
        iou = inter / (area(boxes[i]) + area(boxes[order[1:]]) - inter + 1e-9)
        order = order[1:][iou <= iou_max]
    return np.array(keep, dtype=int)


def detect(path: str):
    img = Image.open(path).convert("RGB")
    x = np.asarray(img.resize((SIZE, SIZE)), dtype=np.float32).transpose(2, 0, 1)[None] / 255.0  # RGB 0-1
    boxes, scores = session.run(None, {"image": x})      # boxes: Nx4 (x1, y1, x2, y2), scores: N
    ok = scores >= SCORE_MIN
    boxes, scores = boxes[ok], scores[ok]
    keep = nms(boxes, scores, IOU_MAX)
    sx, sy = img.width / SIZE, img.height / SIZE          # back to the tile's own pixels
    return [(b * [sx, sy, sx, sy], float(s)) for b, s in zip(boxes[keep], scores[keep])]


for box, score in detect("tile.png"):
    print(f"${spec.className}  {score:.2f}  {box.round(1).tolist()}")
`,
    },
    {
      id: 'pt', title: 'Python · PyTorch (.pt)',
      note: 'The .pt holds only the trained pyramid and detection head. Rebuild the detector with the platform code (build_fcos in geoops-service/app/detect_model.py), which loads DINOv2 from Hugging Face.',
      code: `import torch

artifact = torch.load("${spec.file}.pt", map_location="cpu", weights_only=False)
print(artifact["kind"], artifact["backbone_key"])      # "fcos", "${spec.backbone}"

# model = build_fcos("${spec.backbone}", num_classes=1)   # geoops-service/app/detect_model.py
# model.backbone.pyramid.load_state_dict(artifact["pyramid_state_dict"])
# model.head.load_state_dict(artifact["head_state_dict"])
# model.eval()
# detections = model([image])[0]                          # image: 3x518x518 tensor, RGB 0-1
`,
    },
  ];
}

function save(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** The popup that explains how to run the model, with copyable code. */
function UsageDialog({ spec, onClose }: { spec: Spec; onClose: () => void }) {
  const snips = snippets(spec);
  const [tab, setTab] = useState('onnx');
  const [copied, setCopied] = useState(false);
  const current = snips.find((x) => x.id === tab) ?? snips[0];
  const hubId = spec.backbone === 'dinov2-vitb14' ? 'facebook/dinov2-base' : 'facebook/dinov2-small';
  const hubSize = spec.backbone === 'dinov2-vitb14' ? '~350 MB' : '~90 MB';

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(current.code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { toast.error('Could not copy'); }
  };
  const tabBtn = (on: boolean): React.CSSProperties => ({ height: 30, padding: '0 12px', borderRadius: 6, fontSize: 14, fontWeight: 600, cursor: 'pointer', border: `1px solid ${on ? MC.accent : MC.border}`, background: on ? MC.accentDim : 'transparent', color: MC.text });

  return createPortal(
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 2200, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      <div role="dialog" aria-label="How to use the model" onClick={(e) => e.stopPropagation()}
        style={{ width: 'min(820px, 94vw)', maxHeight: '88vh', display: 'flex', flexDirection: 'column', background: MC.panelBg, border: `1px solid ${MC.border}`, borderRadius: 10, boxShadow: '0 12px 40px rgba(0,0,0,0.35)', overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 18px', borderBottom: `1px solid ${MC.border}`, flexShrink: 0 }}>
          <BookOpen size={16} color={MC.accent} />
          <h3 style={{ margin: 0, flex: 1, fontSize: 17, fontWeight: 700, color: MC.text }}>How to use this model</h3>
          <button type="button" aria-label="Close" onClick={onClose} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: MC.textMuted, padding: 2 }}><X size={18} /></button>
        </div>

        <div style={{ overflowY: 'auto', padding: '16px 18px 20px', display: 'flex', flexDirection: 'column', gap: 16 }}>
          {spec.task === 'yolo' ? (
            <section>
              <h4 style={{ margin: '0 0 6px', fontSize: 15, fontWeight: 700, color: MC.text }}>Does it need anything else?</h4>
              <p style={{ ...muted, fontSize: 14 }}>
                No. Both files hold the whole model and its class names, so nothing else is downloaded. Running them needs the <code>ultralytics</code> package (AGPL-3.0).
              </p>
            </section>
          ) : (
          <section>
            <h4 style={{ margin: '0 0 6px', fontSize: 15, fontWeight: 700, color: MC.text }}>Does it need DINOv2 as a separate download?</h4>
            <p style={{ ...muted, fontSize: 14 }}>
              The trained part is small. It sits on top of the frozen DINOv2 backbone (<b>{spec.backbone}</b>, <code>{hubId}</code>), and where that backbone comes from depends on the file:
            </p>
            <ul style={{ ...muted, fontSize: 14, margin: '6px 0 0', paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 4 }}>
              <li><b>ONNX (.onnx):</b> the backbone is inside the file. Nothing else to download. It runs with ONNX Runtime only.</li>
              <li><b>PyTorch (.pt):</b> only the trained head is in the file. The backbone is not included. The <code>transformers</code> library downloads it from Hugging Face the first time you build the model ({hubSize}), and caches it after that. Offline, download it once and point to the local folder.</li>
            </ul>
          </section>
          )}

          <section>
            <div style={{ display: 'flex', gap: 6, marginBottom: 8, flexWrap: 'wrap' }}>
              {snips.map((x) => (
                <button key={x.id} type="button" aria-pressed={tab === x.id} onClick={() => setTab(x.id)} style={tabBtn(tab === x.id)}>{x.title}</button>
              ))}
            </div>
            <p style={{ ...muted, fontSize: 14, marginBottom: 8 }}>{current.note}</p>
            <div style={{ position: 'relative' }}>
              <button type="button" onClick={copy} aria-label="Copy the code" style={{ position: 'absolute', top: 8, right: 8, display: 'inline-flex', alignItems: 'center', gap: 5, height: 26, padding: '0 9px', borderRadius: 5, border: '1px solid rgba(232,228,216,0.28)', background: 'rgba(232,228,216,0.08)', color: '#e8e4d8', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
                {copied ? <Check size={13} /> : <Copy size={13} />} {copied ? 'Copied' : 'Copy'}
              </button>
              <pre tabIndex={0} style={{ margin: 0, padding: '14px 16px', paddingTop: 40, borderRadius: 8, background: '#1f2619', color: '#e8e4d8', fontSize: 13, lineHeight: 1.6, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', overflow: 'auto', maxHeight: 360, tabSize: 4 }}>
                <code>{current.code}</code>
              </pre>
            </div>
          </section>

          <section>
            <h4 style={{ margin: '0 0 6px', fontSize: 15, fontWeight: 700, color: MC.text }}>Input and output</h4>
            <p style={{ ...muted, fontSize: 14 }}>
              Input: an RGB image resized to 518 × 518, values 0–1 (pixels divided by 255). {spec.task === 'classify'
                ? 'Output: the probability that the class is in the tile.'
                : spec.task === 'yolo'
                  ? 'Output: for each object, a box (pixels of your image), a confidence and the class name.'
                  : spec.task === 'segment'
                  ? 'Output: two maps at 518 × 518, the foreground and the boundary probability. The example turns them into one outline per object, so you get counts, areas and boundaries.'
                  : 'Output: boxes (x1, y1, x2, y2 in those 518 px) and a score for each candidate. Keep the scores above the threshold, then merge overlaps (the example does both).'}
              {spec.tileM ? ` It was trained on tiles about ${spec.tileM} m wide, so cut tiles of that size.` : ''}
            </p>
          </section>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** Per-run model actions as one compact row: Export ▾ (PyTorch, ONNX), How to use, and a small delete button. */
/**
 * Export / how to use / delete for one trained model. ``seed`` targets one seed run of a multi-seed experiment (no delete there: that removes
 * the whole experiment). ``label`` draws a text button instead of the small icon.
 */
export function TrainHeadModelActions({ runId, result, seed, label, title }: { runId: string; result: DinoFinetuneResult; seed?: number; label?: string; title?: string }) {
  const queryClient = useQueryClient();
  const [menu, setMenu] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [usage, setUsage] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const task = result.task;
  const file = `${(result.class_name || 'model').replace(/[^A-Za-z0-9._-]+/g, '_')}_head${seed != null ? `_seed${seed}` : ''}`;
  const spec: Spec = {
    task, className: result.class_name, backbone: result.hyperparameters?.backbone ?? 'dinov2-vits14',
    tileM: result.patch_span_m ?? null, scoreMin: result.eval_result?.score_thresh ?? (task === 'classify' ? 0.5 : 0.3), file,
  };

  const { data: files } = useQuery({ queryKey: ['train-head-model', runId, seed ?? 'kept'], queryFn: () => dinoApi.modelExports(runId, seed) });
  const convert = useMutation({
    mutationFn: () => dinoApi.exportOnnx(runId, seed),
    onSuccess: (r) => { queryClient.setQueryData(['train-head-model', runId, seed ?? 'kept'], r); toast.success('ONNX model ready'); },
    onError: () => toast.error('Could not convert the model to ONNX'),
  });
  const download = useMutation({
    mutationFn: async (format: 'pt' | 'onnx') => save(await dinoApi.downloadModel(runId, format, seed), `${file}.${format}`),
    onSuccess: () => setMenu(false),
    onError: () => toast.error('Could not download the model'),
  });
  const remove = useMutation({
    mutationFn: () => dinoApi.deleteModel(runId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['train-head-model', runId] });
      void queryClient.invalidateQueries({ queryKey: ['models'] });
      setConfirm(false);
      toast.success('Model deleted');
    },
    onError: () => { setConfirm(false); toast.error('Could not delete the model. It needs an admin role.'); },
  });

  // Close the menus on an outside click or Escape.
  useEffect(() => {
    if (!menu && !confirm) return;
    const onDown = (e: MouseEvent) => { if (wrap.current && !wrap.current.contains(e.target as Node)) { setMenu(false); setConfirm(false); } };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setMenu(false); setConfirm(false); } };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey, true);
    return () => { document.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey, true); };
  }, [menu, confirm]);

  const onnxReady = files?.onnx_size_bytes != null;
  const gone = !!files && files.pt_size_bytes == null && !onnxReady;
  if (gone) return <span style={{ ...muted, fontStyle: 'italic' }}>Model deleted</span>;

  return (
    <div ref={wrap} style={{ position: 'relative' }}>
      {label ? (
        <button
          type="button" aria-haspopup="menu" aria-expanded={menu} title={title} aria-label={title ?? label} onClick={() => { setMenu(!menu); setConfirm(false); }}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 6, height: 28, padding: '0 10px', borderRadius: 6, fontSize: 13, fontWeight: 600, cursor: 'pointer',
            color: MC.text, background: menu ? MC.accentDim : 'transparent', border: `1px solid ${menu ? MC.accent : MC.border}`,
          }}
        >
          <Download size={13} /> {label}
        </button>
      ) : (
        <IconButton label="Export, how to use, or delete this model" active={menu} onClick={() => { setMenu(!menu); setConfirm(false); }}>
          <MoreHorizontal size={15} />
        </IconButton>
      )}

      {menu && (
        <div role="menu" style={{ ...popoverStyle, top: 'calc(100% + 4px)', right: 0, minWidth: 250 }}>
          <MenuItem
            icon={download.isPending && download.variables === 'pt' ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
            label="Download PyTorch" hint={files?.pt_size_bytes ? `.pt · ${mb(files.pt_size_bytes)}` : '.pt'}
            disabled={files?.pt_size_bytes == null || download.isPending} onClick={() => download.mutate('pt')}
          />
          {onnxReady ? (
            <MenuItem
              icon={download.isPending && download.variables === 'onnx' ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
              label="Download ONNX" hint={`.onnx · ${mb(files?.onnx_size_bytes)}`} disabled={download.isPending} onClick={() => download.mutate('onnx')}
            />
          ) : (
            <MenuItem
              icon={convert.isPending ? <Loader2 size={14} className="animate-spin" /> : <Repeat2 size={14} />}
              label={convert.isPending ? 'Converting to ONNX…' : 'Convert to ONNX'} disabled={convert.isPending || !files} onClick={() => convert.mutate()}
            />
          )}
          <MenuItem icon={<BookOpen size={14} />} label="How to use" onClick={() => { setMenu(false); setUsage(true); }} />
          {seed != null ? null : confirm ? (
            <div style={{ display: 'flex', gap: 6, padding: '4px 6px' }}>
              <button type="button" onClick={() => setConfirm(false)} style={{ flex: 1, height: 28, borderRadius: 5, border: `1px solid ${MC.border}`, background: 'transparent', color: MC.text, fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>Back</button>
              <button type="button" disabled={remove.isPending} onClick={() => remove.mutate()} style={{ flex: 1, height: 28, borderRadius: 5, border: 'none', background: '#dc2626', color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>
                {remove.isPending ? 'Deleting…' : 'Confirm delete'}
              </button>
            </div>
          ) : (
            <MenuItem icon={<Trash2 size={14} />} label="Delete model" danger onClick={() => setConfirm(true)} />
          )}
        </div>
      )}

      {usage && <UsageDialog spec={spec} onClose={() => setUsage(false)} />}
    </div>
  );
}
