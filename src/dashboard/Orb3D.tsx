import { useEffect, useRef } from 'react';

interface OrbProps {
  size?: number;
  interactive?: boolean;
  className?: string;
}

/**
 * High-performance 3D glossy orb inspired by Contra & modern 3D design references.
 * Features specular lighting, warm ambient backlight, 3D rotating rings, and floating orbs.
 */
export function Orb3D({ size = 320, interactive = true, className = '' }: OrbProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const state = useRef({
    mouseX: 0.5,
    mouseY: 0.5,
    targetMouseX: 0.5,
    targetMouseY: 0.5,
    rotation: 0,
    time: 0,
  });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let animId = 0;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = size * dpr;
    canvas.height = size * dpr;

    const handlePointerMove = (e: MouseEvent) => {
      if (!interactive) return;
      const rect = canvas.getBoundingClientRect();
      state.current.targetMouseX = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      state.current.targetMouseY = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
    };

    const handleGlobalMove = (e: MouseEvent) => {
      if (!interactive) return;
      const rect = canvas.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const dx = (e.clientX - cx) / (window.innerWidth / 2);
      const dy = (e.clientY - cy) / (window.innerHeight / 2);
      state.current.targetMouseX = 0.5 + dx * 0.35;
      state.current.targetMouseY = 0.5 + dy * 0.35;
    };

    window.addEventListener('mousemove', handleGlobalMove, { passive: true });
    canvas.addEventListener('mousemove', handlePointerMove, { passive: true });

    const render = () => {
      const s = state.current;
      s.time += 0.015;
      s.rotation += 0.008;

      // Smooth lerp mouse coordinates
      s.mouseX += (s.targetMouseX - s.mouseX) * 0.06;
      s.mouseY += (s.targetMouseY - s.mouseY) * 0.06;

      const w = canvas.width;
      const h = canvas.height;
      const cx = w / 2;
      const cy = h / 2;
      const radius = (size * 0.32) * dpr;

      ctx.clearRect(0, 0, w, h);

      // 1. Warm glowing ambient backlight (Contra orange/amber glow)
      const glowX = cx + (s.mouseX - 0.5) * 50 * dpr + Math.cos(s.time * 0.8) * 15 * dpr;
      const glowY = cy + (s.mouseY - 0.5) * 50 * dpr + Math.sin(s.time * 0.8) * 15 * dpr;
      const backGlow = ctx.createRadialGradient(
        glowX + radius * 0.65,
        glowY - radius * 0.15,
        radius * 0.1,
        glowX + radius * 0.65,
        glowY - radius * 0.15,
        radius * 1.5,
      );
      backGlow.addColorStop(0, 'rgba(255, 158, 44, 0.85)');
      backGlow.addColorStop(0.35, 'rgba(244, 63, 94, 0.45)');
      backGlow.addColorStop(0.7, 'rgba(139, 92, 246, 0.2)');
      backGlow.addColorStop(1, 'rgba(0, 0, 0, 0)');

      ctx.save();
      ctx.fillStyle = backGlow;
      ctx.beginPath();
      ctx.arc(glowX + radius * 0.65, glowY - radius * 0.15, radius * 1.4, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      // 2. Secondary glowing satellite sphere (Golden mini sphere like in Contra)
      const satRadius = radius * 0.42;
      const satX = cx + Math.cos(s.time * 0.7 + 1.2) * (radius * 1.05) + (s.mouseX - 0.5) * 20 * dpr;
      const satY = cy + Math.sin(s.time * 0.7 + 1.2) * (radius * 0.45) + (s.mouseY - 0.5) * 20 * dpr;

      const satGrad = ctx.createRadialGradient(
        satX - satRadius * 0.35,
        satY - satRadius * 0.35,
        satRadius * 0.05,
        satX,
        satY,
        satRadius,
      );
      satGrad.addColorStop(0, '#fff4cc');
      satGrad.addColorStop(0.25, '#fbbf24');
      satGrad.addColorStop(0.65, '#f97316');
      satGrad.addColorStop(1, '#9a3412');

      ctx.save();
      ctx.fillStyle = satGrad;
      ctx.shadowColor = 'rgba(251, 146, 60, 0.6)';
      ctx.shadowBlur = 24 * dpr;
      ctx.beginPath();
      ctx.arc(satX, satY, satRadius, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      // 3. 3D Orbital ring with perspective tilt
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(0.35 + (s.mouseX - 0.5) * 0.2);
      ctx.scale(1, 0.38);

      ctx.beginPath();
      ctx.arc(0, 0, radius * 1.35, 0, Math.PI * 2);
      ctx.lineWidth = 1.8 * dpr;
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.18)';
      ctx.setLineDash([8 * dpr, 12 * dpr]);
      ctx.lineDashOffset = -s.rotation * 40;
      ctx.stroke();

      // Second fine outer ring
      ctx.beginPath();
      ctx.arc(0, 0, radius * 1.62, 0, Math.PI * 2);
      ctx.lineWidth = 1.2 * dpr;
      ctx.strokeStyle = 'rgba(251, 146, 60, 0.25)';
      ctx.setLineDash([4 * dpr, 20 * dpr]);
      ctx.lineDashOffset = s.rotation * 30;
      ctx.stroke();
      ctx.restore();

      // 4. Main Obsidian 3D Sphere (Deep metallic black with realistic phong specular highlight & rim light)
      const sphereX = cx + (s.mouseX - 0.5) * 25 * dpr;
      const sphereY = cy + (s.mouseY - 0.5) * 25 * dpr;

      // Base shadow under sphere
      ctx.save();
      const dropShadow = ctx.createRadialGradient(
        sphereX,
        sphereY + radius * 0.85,
        radius * 0.2,
        sphereX,
        sphereY + radius * 0.85,
        radius * 1.2,
      );
      dropShadow.addColorStop(0, 'rgba(0, 0, 0, 0.65)');
      dropShadow.addColorStop(1, 'rgba(0, 0, 0, 0)');
      ctx.fillStyle = dropShadow;
      ctx.beginPath();
      ctx.ellipse(sphereX, sphereY + radius * 0.9, radius * 0.9, radius * 0.3, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      // Sphere surface gradient
      const lightSourceX = sphereX - radius * 0.4 + (s.mouseX - 0.5) * 40 * dpr;
      const lightSourceY = sphereY - radius * 0.4 + (s.mouseY - 0.5) * 40 * dpr;

      const sphereGrad = ctx.createRadialGradient(
        lightSourceX,
        lightSourceY,
        radius * 0.05,
        sphereX,
        sphereY,
        radius,
      );
      // Obsidian chrome finish
      sphereGrad.addColorStop(0, '#52525b');
      sphereGrad.addColorStop(0.18, '#27272a');
      sphereGrad.addColorStop(0.55, '#18181b');
      sphereGrad.addColorStop(0.85, '#09090b');
      sphereGrad.addColorStop(1, '#000000');

      ctx.save();
      ctx.fillStyle = sphereGrad;
      ctx.beginPath();
      ctx.arc(sphereX, sphereY, radius, 0, Math.PI * 2);
      ctx.fill();

      // Rim light reflection on edge (Warm rim on right from the golden satellite orb, Cool rim on left)
      const rimGrad = ctx.createLinearGradient(
        sphereX - radius,
        sphereY - radius,
        sphereX + radius,
        sphereY + radius,
      );
      rimGrad.addColorStop(0, 'rgba(255, 255, 255, 0.25)');
      rimGrad.addColorStop(0.5, 'rgba(255, 255, 255, 0)');
      rimGrad.addColorStop(0.85, 'rgba(251, 146, 60, 0.4)');
      rimGrad.addColorStop(1, 'rgba(255, 180, 80, 0.7)');

      ctx.lineWidth = 2.5 * dpr;
      ctx.strokeStyle = rimGrad;
      ctx.stroke();

      // High-gloss specular highlight (White hot glossy spot reflection)
      const specGrad = ctx.createRadialGradient(
        lightSourceX,
        lightSourceY,
        0,
        lightSourceX,
        lightSourceY,
        radius * 0.35,
      );
      specGrad.addColorStop(0, 'rgba(255, 255, 255, 0.85)');
      specGrad.addColorStop(0.2, 'rgba(255, 255, 255, 0.45)');
      specGrad.addColorStop(0.6, 'rgba(255, 255, 255, 0.08)');
      specGrad.addColorStop(1, 'rgba(255, 255, 255, 0)');

      ctx.fillStyle = specGrad;
      ctx.beginPath();
      ctx.arc(lightSourceX, lightSourceY, radius * 0.35, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      // 5. Floating particle specks for depth
      const numParticles = 6;
      ctx.save();
      for (let i = 0; i < numParticles; i++) {
        const pAngle = s.time * 0.5 + (i * Math.PI * 2) / numParticles;
        const pDist = radius * (1.15 + 0.3 * Math.sin(i * 1.5 + s.time * 0.4));
        const px = cx + Math.cos(pAngle) * pDist;
        const py = cy + Math.sin(pAngle) * pDist * 0.7;
        const pSize = (1.5 + Math.sin(s.time * 2 + i) * 0.8) * dpr;

        ctx.fillStyle = i % 2 === 0 ? 'rgba(251, 146, 60, 0.75)' : 'rgba(255, 255, 255, 0.7)';
        ctx.beginPath();
        ctx.arc(px, py, pSize, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();

      animId = requestAnimationFrame(render);
    };

    render();

    return () => {
      cancelAnimationFrame(animId);
      window.removeEventListener('mousemove', handleGlobalMove);
      canvas.removeEventListener('mousemove', handlePointerMove);
    };
  }, [size, interactive]);

  return (
    <div
      className={`orb-container ${className}`}
      style={{
        width: size,
        height: size,
        position: 'relative',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <canvas
        ref={canvasRef}
        style={{
          width: size,
          height: size,
          pointerEvents: interactive ? 'auto' : 'none',
        }}
      />
    </div>
  );
}
