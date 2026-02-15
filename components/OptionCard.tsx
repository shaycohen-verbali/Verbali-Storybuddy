import React from 'react';
import { Option } from '../types';
import { Loader2, Image as ImageIcon } from 'lucide-react';

interface OptionCardProps {
  option: Option;
  onClick: (option: Option) => void;
  selected: boolean;
}

const OptionCardComponent: React.FC<OptionCardProps> = ({ option, onClick, selected }) => {
  return (
    <button
      onClick={() => onClick(option)}
      className={`
        relative group flex flex-col items-center w-full h-full p-4 rounded-3xl transition-all duration-300
        ${selected ? 'ring-8 ring-kid-yellow scale-105' : 'hover:scale-105 hover:shadow-2xl shadow-xl bg-white'}
      `}
    >
      <div className="w-full aspect-square rounded-2xl overflow-hidden bg-gray-100 mb-4 relative flex items-center justify-center border-2 border-gray-100">
        {option.isLoadingImage ? (
          <div className="flex flex-col items-center text-gray-400">
            <Loader2 className="w-12 h-12 animate-spin mb-2" />
            <span className="text-sm font-medium">Painting...</span>
          </div>
        ) : option.imageUrl ? (
          <img 
            src={option.imageUrl} 
            alt={option.text} 
            className="w-full h-full object-cover"
          />
        ) : (
          <ImageIcon className="w-16 h-16 text-gray-300" />
        )}
      </div>
      
      <div className="w-full bg-kid-teal/10 rounded-xl p-3 text-center">
        <p className="text-xl md:text-2xl font-bold text-gray-800 break-words leading-tight">
          {option.text}
        </p>
      </div>
    </button>
  );
};

const OptionCard = React.memo(OptionCardComponent);
export default OptionCard;
