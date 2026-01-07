<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import type { Book } from '../../../library/types';
  import ProgressBar from '../charts/ProgressBar.svelte';

  export let book: Book;
  export let showProgress: boolean = true;
  export let showResume: boolean = true;

  const dispatch = createEventDispatcher<{
    click: void;
    resume: void;
  }>();

  function handleClick() {
    dispatch('click');
  }

  function handleResume(event: MouseEvent) {
    event.stopPropagation();
    dispatch('resume');
  }

  // Format last read date
  function formatLastRead(date: Date | undefined): string {
    if (!date) return '';
    const d = date instanceof Date ? date : new Date(date);
    const now = Date.now();
    const diff = now - d.getTime();
    const hours = Math.floor(diff / (60 * 60 * 1000));

    if (hours < 1) return 'Just now';
    if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
    const days = Math.floor(hours / 24);
    if (days === 1) return 'Yesterday';
    if (days < 7) return `${days} days ago`;
    return d.toLocaleDateString();
  }

  $: lastReadText = formatLastRead(book.lastRead);
</script>

<div class="book-card" on:click={handleClick} role="button" tabindex="0">
  <div class="book-icon">📖</div>
  <div class="book-content">
    <div class="book-title">{book.title}</div>
    {#if book.author}
      <div class="book-author">{book.author}</div>
    {/if}
    {#if showProgress}
      <div class="book-progress">
        <ProgressBar percent={book.progress} width={20} />
      </div>
    {/if}
    {#if lastReadText}
      <div class="book-last-read">Last read: {lastReadText}</div>
    {/if}
  </div>
  {#if showResume}
    <button class="resume-btn" on:click={handleResume}>
      Resume →
    </button>
  {/if}
</div>

<style>
  .book-card {
    display: flex;
    align-items: flex-start;
    gap: var(--size-4-2);
    padding: var(--size-4-3);
    background: var(--background-secondary);
    border-radius: var(--radius-s);
    cursor: pointer;
    transition: background-color 0.15s ease;
  }

  .book-card:hover {
    background: var(--background-modifier-hover);
  }

  .book-card:focus-visible {
    outline: 2px solid var(--color-accent);
    outline-offset: 2px;
  }

  .book-icon {
    font-size: 20px;
    flex-shrink: 0;
  }

  .book-content {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .book-title {
    font-weight: 600;
    font-size: var(--font-ui-small);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .book-author {
    font-size: var(--font-ui-smaller);
    color: var(--text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .book-progress {
    margin-top: var(--size-4-1);
  }

  .book-last-read {
    font-size: var(--font-ui-smaller);
    color: var(--text-faint);
  }

  .resume-btn {
    flex-shrink: 0;
    align-self: center;
    padding: var(--size-4-1) var(--size-4-2);
    background: var(--interactive-accent);
    border: none;
    border-radius: var(--radius-s);
    color: var(--text-on-accent);
    font-size: var(--font-ui-smaller);
    cursor: pointer;
    transition: background-color 0.15s ease;
  }

  .resume-btn:hover {
    background: var(--interactive-accent-hover);
  }
</style>
