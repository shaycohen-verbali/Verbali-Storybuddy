import React, { useState, useRef } from 'react';
import { ChevronLeft, ChevronRight, Check, X } from 'lucide-react';

interface ImageCropperProps {
  pages: string[]; // Base64 images of pages
  targetName: string;
  onConfirm: (croppedImage: string) => void;
  onCancel: () => void;
}

const ImageCropper: React.FC<ImageCropperProps> = ({ pages, targetName, onConfirm, onCancel }) => {
  const [currentPageIndex, setCurrentPageIndex] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const [startPos, setStartPos] = useState({ x: 0, y: 0 });
  const [currentPos, setCurrentPos] = useState({ x: 0, y: 0 });
  
  const imgRef = useRef<HTMLImageElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const handleMouseDown = (e: React.MouseEvent) => {
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    
    setStartPos({ x, y });
    setCurrentPos({ x, y });
    setIsDragging(true);
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!isDragging || !containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
    const y = Math.max(0, Math.min(e.clientY - rect.top, rect.height));
    setCurrentPos({ x, y });
  };

  const handleMouseUp = () => {
    setIsDragging(false);
  };

  const getCropRect = () => {
    const x = Math.min(startPos.x, currentPos.x);
    const y = Math.min(startPos.y, currentPos.y);
    const w = Math.abs(currentPos.x - startPos.x);
    const h = Math.abs(currentPos.y - startPos.y);
    return { x, y, w, h };
  };

  const handleCrop = () => {
    if (!imgRef.current || !containerRef.current) return;
    
    const rect = getCropRect();
    if (rect.w < 10 || rect.h < 10) return; // Ignore accidental clicks

    // Calculate scaling factor between displayed image and natural image size
    const displayWidth = containerRef.current.clientWidth;
    const naturalWidth = imgRef.current.naturalWidth;
    const scale = naturalWidth / displayWidth;

    const canvas = document.createElement('canvas');
    canvas.width = rect.w * scale;
    canvas.height = rect.h * scale;
    const ctx = canvas.getContext('2d');

    if (ctx) {
      ctx.drawImage(
        imgRef.current,
        rect.x * scale, rect.y * scale, rect.w * scale, rect.h * scale,
        0, 0, rect.w * scale, rect.h * scale
      );
      onConfirm(canvas.toDataURL('image/png'));
    }
  };

  const selectionBox = getCropRect();

  return (
    <div className="fixed inset-0 bg-black/95 backdrop-blur-md z-[60] flex flex-col h-screen">
      
      {/* Top Header - Controls moved here to avoid covering image */}
      <div className="flex-none p-4 flex flex-col gap-4 bg-gray-900 border-b border-gray-800">
        <div className="flex justify-between items-center text-white">
            <div className="flex items-center gap-3">
              <h3 className="text-xl font-bold">Crop "{targetName}"</h3>
              <div className="bg-gray-800 px-3 py-1 rounded-full text-xs text-gray-400">
                Drag to select area
              </div>
            </div>
            <button onClick={onCancel} className="p-2 hover:bg-white/10 rounded-full">
              <X className="w-6 h-6" />
            </button>
        </div>

        {/* Pagination & Confirm Row */}
        <div className="flex justify-between items-center">
             <div className="flex items-center gap-4 bg-gray-800 px-4 py-2 rounded-lg text-white">
                <button 
                  onClick={() => setCurrentPageIndex(p => Math.max(0, p - 1))}
                  disabled={currentPageIndex === 0}
                  className="hover:text-kid-blue disabled:text-gray-600 disabled:cursor-not-allowed"
                >
                  <ChevronLeft className="w-6 h-6" />
                </button>
                <span className="font-mono text-sm w-20 text-center">
                   {currentPageIndex + 1} / {pages.length}
                </span>
                <button 
                  onClick={() => setCurrentPageIndex(p => Math.min(pages.length - 1, p + 1))}
                  disabled={currentPageIndex === pages.length - 1}
                  className="hover:text-kid-blue disabled:text-gray-600 disabled:cursor-not-allowed"
                >
                  <ChevronRight className="w-6 h-6" />
                </button>
             </div>

             <button 
               onClick={handleCrop}
               disabled={selectionBox.w < 10}
               className="px-6 py-2 bg-kid-blue text-white rounded-lg font-bold hover:bg-blue-600 transition disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
             >
               <Check className="w-5 h-5" /> Confirm Crop
             </button>
        </div>
      </div>

      {/* Main Content - Takes remaining space */}
      <div className="flex-1 overflow-hidden relative flex items-center justify-center bg-black p-4">
         <div 
           ref={containerRef}
           className="relative cursor-crosshair shadow-2xl inline-block"
           onMouseDown={handleMouseDown}
           onMouseMove={handleMouseMove}
           onMouseUp={handleMouseUp}
           onMouseLeave={handleMouseUp}
         >
           <img 
             ref={imgRef}
             src={pages[currentPageIndex]} 
             className="max-h-[calc(100vh-180px)] object-contain select-none pointer-events-none" 
             alt="PDF Page"
             draggable={false}
           />
           
           {/* Selection Overlay */}
           {(selectionBox.w > 0 && selectionBox.h > 0) && (
              <div 
                className="absolute border-2 border-kid-blue bg-kid-blue/20"
                style={{
                  left: selectionBox.x,
                  top: selectionBox.y,
                  width: selectionBox.w,
                  height: selectionBox.h,
                }}
              />
           )}
         </div>
      </div>

    </div>
  );
};

export default ImageCropper;
