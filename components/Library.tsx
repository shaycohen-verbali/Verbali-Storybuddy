import React from 'react';
import { BookOpen, Plus, Trash2, Calendar } from 'lucide-react';
import { StoryManifest } from '../types';

interface LibraryProps {
  stories: StoryManifest[];
  onSelectStory: (story: StoryManifest) => void;
  onDeleteStory: (id: string) => void;
  onAddNew: () => void;
}

const Library: React.FC<LibraryProps> = ({ stories, onSelectStory, onDeleteStory, onAddNew }) => {
  return (
    <div className="w-full max-w-5xl mx-auto p-4 animate-fade-in-up">
       <div className="flex justify-between items-center mb-8">
           <h2 className="text-3xl font-bold text-gray-800 flex items-center gap-3">
               <span className="bg-kid-blue text-white p-3 rounded-2xl">
                   <BookOpen className="w-8 h-8" />
               </span>
               My Library
           </h2>
           <button 
             onClick={onAddNew}
             className="px-6 py-3 bg-kid-pink text-white font-bold rounded-xl shadow-lg hover:bg-pink-500 transition flex items-center gap-2"
           >
               <Plus className="w-5 h-5" /> New Story
           </button>
       </div>

       {stories.length === 0 ? (
           <div className="flex flex-col items-center justify-center py-20 bg-white rounded-3xl border-2 border-dashed border-gray-200">
               <div className="w-24 h-24 bg-gray-50 rounded-full flex items-center justify-center mb-4">
                   <BookOpen className="w-10 h-10 text-gray-300" />
               </div>
               <h3 className="text-xl font-bold text-gray-400 mb-2">No stories yet</h3>
               <p className="text-gray-400 mb-6">Upload a PDF to get started!</p>
               <button onClick={onAddNew} className="text-kid-blue font-bold hover:underline">
                   Create your first story
               </button>
           </div>
       ) : (
           <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-6">
               {stories.map(story => (
                   <div key={story.id} className="group bg-white rounded-2xl p-4 shadow-sm hover:shadow-xl transition-all border border-gray-100 flex flex-col relative">
                       <div 
                         onClick={() => onSelectStory(story)}
                         className="w-full aspect-[3/4] bg-gray-100 rounded-xl mb-4 overflow-hidden cursor-pointer relative"
                       >
                           {story.coverImage ? (
                               <img src={story.coverImage} className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105" />
                           ) : (
                               <div className="w-full h-full flex items-center justify-center bg-gray-50 text-gray-300">
                                   <BookOpen className="w-12 h-12" />
                               </div>
                           )}
                           <div className="absolute inset-0 bg-black/0 group-hover:bg-black/10 transition-colors" />
                       </div>

                       <div className="flex-1 cursor-pointer" onClick={() => onSelectStory(story)}>
                           <h3 className="font-bold text-gray-800 text-lg leading-tight mb-2 line-clamp-2">{story.title}</h3>
                           <div className="flex items-center gap-2 text-xs text-gray-400">
                               <Calendar className="w-3 h-3" />
                               {new Date(story.createdAt).toLocaleDateString()}
                           </div>
                       </div>
                       
                       <button 
                         onClick={(e) => { e.stopPropagation(); onDeleteStory(story.id); }}
                         className="absolute top-6 right-6 p-2 bg-white/90 text-red-500 rounded-full opacity-0 group-hover:opacity-100 transition shadow-sm hover:bg-red-50"
                         title="Delete Story"
                       >
                           <Trash2 className="w-4 h-4" />
                       </button>
                   </div>
               ))}
           </div>
       )}
    </div>
  );
};

export default Library;
