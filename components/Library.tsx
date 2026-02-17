import React, { useMemo, useState } from 'react';
import { BookOpen, Calendar, FolderOpen, Plus, Trash2 } from 'lucide-react';
import { Publisher, StoryManifest } from '../types';

interface LibraryProps {
  stories: StoryManifest[];
  publishers: Publisher[];
  onSelectStory: (story: StoryManifest) => void;
  onOpenSetup: (story: StoryManifest) => void;
  onDeleteStory: (id: string) => void;
  onAddNew: () => void;
  onAddBookToPublisher: (publisher: Publisher) => void;
  onCreatePublisher: (name: string) => Promise<void>;
}

const Library: React.FC<LibraryProps> = ({
  stories,
  publishers,
  onSelectStory,
  onOpenSetup,
  onDeleteStory,
  onAddNew,
  onAddBookToPublisher,
  onCreatePublisher
}) => {
  const [showCreatePublisher, setShowCreatePublisher] = useState(false);
  const [newPublisherName, setNewPublisherName] = useState('');
  const [isSavingPublisher, setIsSavingPublisher] = useState(false);
  const [publisherError, setPublisherError] = useState<string | null>(null);

  const regularBooks = useMemo(
    () => stories.filter((story) => !story.publisherId),
    [stories]
  );

  const publisherSections = useMemo(
    () =>
      publishers.map((publisher) => ({
        publisher,
        books: stories.filter((story) => story.publisherId === publisher.id)
      })),
    [publishers, stories]
  );

  const handleCreatePublisher = async () => {
    const trimmed = newPublisherName.trim();
    if (!trimmed) {
      return;
    }

    setIsSavingPublisher(true);
    setPublisherError(null);
    try {
      await onCreatePublisher(trimmed);
      setNewPublisherName('');
      setShowCreatePublisher(false);
    } catch (error: any) {
      setPublisherError(error?.message || 'Failed to create publisher');
    } finally {
      setIsSavingPublisher(false);
    }
  };

  const renderStoryCard = (story: StoryManifest) => (
    <div key={story.id} className="group bg-white rounded-2xl p-4 shadow-sm hover:shadow-xl transition-all border border-gray-100 flex flex-col relative">
      <div
        onClick={() => onOpenSetup(story)}
        className="w-full aspect-[3/4] bg-gray-100 rounded-xl mb-4 overflow-hidden cursor-pointer relative"
        title="Open setup details"
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

      <div className="flex-1 cursor-pointer" onClick={() => onOpenSetup(story)}>
        <h3 className="font-bold text-gray-800 text-lg leading-tight mb-2 line-clamp-2">{story.title}</h3>
        <div className="flex items-center gap-2 text-xs text-gray-400">
          <Calendar className="w-3 h-3" />
          {new Date(story.createdAt).toLocaleDateString()}
        </div>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-2">
        <button
          onClick={() => onOpenSetup(story)}
          className="px-3 py-2 rounded-lg bg-gray-100 text-gray-700 text-sm font-semibold hover:bg-gray-200 transition"
        >
          Setup
        </button>
        <button
          onClick={() => onSelectStory(story)}
          className="px-3 py-2 rounded-lg bg-kid-blue text-white text-sm font-semibold hover:bg-blue-600 transition"
        >
          Start
        </button>
      </div>

      <button
        onClick={(e) => { e.stopPropagation(); onDeleteStory(story.id); }}
        className="absolute top-6 right-6 p-2 bg-white/90 text-red-500 rounded-full opacity-0 group-hover:opacity-100 transition shadow-sm hover:bg-red-50"
        title="Delete Story"
      >
        <Trash2 className="w-4 h-4" />
      </button>
    </div>
  );

  return (
    <div className="w-full max-w-5xl mx-auto p-4 animate-fade-in-up">
      <div className="flex justify-between items-center mb-8 gap-4">
        <h2 className="text-3xl font-bold text-gray-800 flex items-center gap-3">
          <span className="bg-kid-blue text-white p-3 rounded-2xl">
            <BookOpen className="w-8 h-8" />
          </span>
          My Library
        </h2>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowCreatePublisher((prev) => !prev)}
            className="px-4 py-3 bg-white text-gray-700 font-bold rounded-xl shadow hover:bg-gray-50 transition border border-gray-200"
          >
            New Publisher
          </button>
          <button
            onClick={onAddNew}
            className="px-6 py-3 bg-kid-pink text-white font-bold rounded-xl shadow-lg hover:bg-pink-500 transition flex items-center gap-2"
          >
            <Plus className="w-5 h-5" /> New Book
          </button>
        </div>
      </div>

      {showCreatePublisher && (
        <div className="mb-6 bg-white rounded-2xl p-4 border border-gray-200 shadow-sm flex flex-col sm:flex-row gap-3">
          <div className="flex-1">
            <input
              value={newPublisherName}
              onChange={(event) => setNewPublisherName(event.target.value)}
              placeholder="Publisher name"
              className="w-full px-4 py-3 rounded-xl border border-gray-200 focus:outline-none focus:ring-2 focus:ring-kid-blue/30"
            />
            {publisherError && (
              <p className="text-xs text-red-500 mt-2">{publisherError}</p>
            )}
          </div>
          <div className="flex gap-2">
            <button
              onClick={handleCreatePublisher}
              disabled={isSavingPublisher || !newPublisherName.trim()}
              className="px-4 py-3 rounded-xl bg-kid-blue text-white font-semibold disabled:opacity-50"
            >
              {isSavingPublisher ? 'Saving...' : 'Create'}
            </button>
            <button
              onClick={() => {
                setShowCreatePublisher(false);
                setNewPublisherName('');
                setPublisherError(null);
              }}
              className="px-4 py-3 rounded-xl bg-gray-100 text-gray-600 font-semibold"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {stories.length === 0 && publishers.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 bg-white rounded-3xl border-2 border-dashed border-gray-200">
          <div className="w-24 h-24 bg-gray-50 rounded-full flex items-center justify-center mb-4">
            <BookOpen className="w-10 h-10 text-gray-300" />
          </div>
          <h3 className="text-xl font-bold text-gray-400 mb-2">No books or publishers yet</h3>
          <p className="text-gray-400 mb-6">Create a publisher folder or add a regular book.</p>
          <div className="flex items-center gap-3">
            <button onClick={() => setShowCreatePublisher(true)} className="text-gray-600 font-bold hover:underline">
              Create publisher
            </button>
            <button onClick={onAddNew} className="text-kid-blue font-bold hover:underline">
              Add regular book
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-8">
          {publisherSections.map(({ publisher, books }) => (
            <section key={publisher.id} className="bg-white rounded-2xl p-4 border border-gray-100 shadow-sm">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                  <FolderOpen className="w-5 h-5 text-kid-orange" />
                  <h3 className="text-xl font-bold text-gray-800">{publisher.name}</h3>
                  <span className="text-xs font-semibold text-gray-400">{books.length} books</span>
                </div>
                <button
                  onClick={() => onAddBookToPublisher(publisher)}
                  className="px-3 py-2 rounded-lg bg-kid-orange text-white text-sm font-semibold hover:bg-orange-500 transition flex items-center gap-1"
                >
                  <Plus className="w-4 h-4" /> Add Book
                </button>
              </div>

              {books.length === 0 ? (
                <div className="rounded-xl border border-dashed border-gray-200 p-6 text-sm text-gray-500">
                  No books in this publisher yet.
                </div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-6">
                  {books.map((story) => renderStoryCard(story))}
                </div>
              )}
            </section>
          ))}

          <section className="bg-white rounded-2xl p-4 border border-gray-100 shadow-sm">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-xl font-bold text-gray-800">Regular Books</h3>
              <button
                onClick={onAddNew}
                className="px-3 py-2 rounded-lg bg-gray-100 text-gray-700 text-sm font-semibold hover:bg-gray-200 transition flex items-center gap-1"
              >
                <Plus className="w-4 h-4" /> Add Book
              </button>
            </div>
            {regularBooks.length === 0 ? (
              <div className="rounded-xl border border-dashed border-gray-200 p-6 text-sm text-gray-500">
                No regular books yet.
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-6">
                {regularBooks.map((story) => renderStoryCard(story))}
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
};

export default Library;
