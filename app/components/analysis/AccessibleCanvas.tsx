"use client";

import {
  forwardRef,
  type CanvasHTMLAttributes,
} from "react";

interface AccessibleCanvasProps
  extends Omit<CanvasHTMLAttributes<HTMLCanvasElement>, "aria-label" | "role"> {
  description: string;
}

/**
 * Canvas の描画結果を、1つの図としてアクセシビリティツリーへ公開する。
 * `description` は手法の固定説明ではなく、その時点の計算結果から生成する。
 */
const AccessibleCanvas = forwardRef<HTMLCanvasElement, AccessibleCanvasProps>(
  function AccessibleCanvas({ description, ...props }, ref) {
    return (
      <canvas
        {...props}
        ref={ref}
        role="img"
        aria-label={description}
      />
    );
  },
);

export default AccessibleCanvas;
