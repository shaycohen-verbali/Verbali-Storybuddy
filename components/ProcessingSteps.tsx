import React from 'react';
import { Loader2, CheckCircle2, Circle, Mic, BrainCircuit, Palette } from 'lucide-react';
import { ProcessingStage } from '../types';

interface ProcessingStepsProps {
  stage: ProcessingStage;
}

const ProcessingSteps: React.FC<ProcessingStepsProps> = ({ stage }) => {
  const steps = [
    { 
      id: 'transcribing', 
      label: 'Hearing Question', 
      icon: Mic 
    },
    { 
      id: 'generating_options', 
      label: 'Thinking of Answers', 
      icon: BrainCircuit 
    },
    { 
      id: 'generating_images', 
      label: 'Painting Pictures', 
      icon: Palette 
    },
  ];

  const getStepStatus = (stepId: string) => {
    const stepOrder = ['idle', 'transcribing', 'generating_options', 'generating_images', 'completed'];
    const currentIndex = stepOrder.indexOf(stage);
    const stepIndex = stepOrder.indexOf(stepId);

    if (currentIndex > stepIndex) return 'completed';
    if (currentIndex === stepIndex) return 'active';
    return 'pending';
  };

  if (stage === 'idle' || stage === 'error') return null;

  return (
    <div className="w-full max-w-lg bg-white/80 backdrop-blur-sm rounded-2xl p-6 shadow-xl border border-white/60 animate-fade-in-up mx-auto">
      <div className="flex justify-between items-center relative">
        {/* Connecting Line */}
        <div className="absolute top-1/2 left-0 w-full h-1 bg-gray-200 -z-10 rounded-full" />
        <div 
          className="absolute top-1/2 left-0 h-1 bg-kid-blue -z-10 rounded-full transition-all duration-500"
          style={{ 
            width: stage === 'transcribing' ? '15%' : 
                   stage === 'generating_options' ? '50%' : 
                   stage === 'generating_images' ? '85%' : '100%' 
          }}
        />

        {steps.map((step) => {
          const status = getStepStatus(step.id);
          const Icon = step.icon;
          
          return (
            <div key={step.id} className="flex flex-col items-center gap-2 bg-white/0">
              <div 
                className={`
                  w-12 h-12 rounded-full flex items-center justify-center border-4 transition-all duration-300 z-10 bg-white
                  ${status === 'active' ? 'border-kid-blue scale-110 shadow-lg shadow-kid-blue/20' : 
                    status === 'completed' ? 'border-green-400 bg-green-50' : 'border-gray-200'}
                `}
              >
                {status === 'active' ? (
                  <Loader2 className="w-6 h-6 text-kid-blue animate-spin" />
                ) : status === 'completed' ? (
                  <CheckCircle2 className="w-6 h-6 text-green-500" />
                ) : (
                  <Icon className="w-5 h-5 text-gray-300" />
                )}
              </div>
              <span className={`text-xs font-bold uppercase tracking-wider transition-colors duration-300 ${
                status === 'active' ? 'text-kid-blue' : 
                status === 'completed' ? 'text-green-600' : 'text-gray-400'
              }`}>
                {step.label}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default ProcessingSteps;
