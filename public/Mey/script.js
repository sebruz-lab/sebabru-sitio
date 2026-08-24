gsap.registerPlugin(ScrollTrigger)

const SCROLL_PER_BOOK = 3000

const scrollSpace    = document.getElementById('scroll-space')
const artistSection  = document.getElementById('artist-section')
const lastIndex      = books.length - 1

// ── Drivers: proveen la altura de scroll ──────────────────────
books.forEach((_, i) => {
  const d = document.createElement('div')
  d.className = 'driver'
  d.id = 'driver-' + i
  d.style.height = SCROLL_PER_BOOK + 'px'
  scrollSpace.appendChild(d)
})

// Spacer final: permite que el último driver llegue a "bottom = top"
// (sin él el scroll máximo es totalHeight - 100vh, la timeline nunca llega al 100%)
const endSpacer = document.createElement('div')
endSpacer.style.height = '100svh'
scrollSpace.appendChild(endSpacer)

// ── Secciones de libro: fixed, apiladas ───────────────────────
books.forEach((bookData, i) => {
  const section = document.createElement('section')
  section.className = 'book-section'
  section.id        = 'book-' + i
  section.style.zIndex = (books.length - i + 1) * 10   // book-0: 30, book-1: 20

  // Último libro: fondo blanco para la transición a Mey
  if (i === lastIndex) section.classList.add('is-white')

  section.innerHTML = `
    <div class="scene">
      <div class="book">
        <div class="book-spread spread-2">
          <img src="${bookData.pages[1]}" alt="" loading="lazy">
        </div>
        <div class="book-spread spread-1">
          <img src="${bookData.pages[0]}" alt="" loading="lazy">
        </div>
        <div class="book-front">
          <img src="${bookData.cover}" alt="" loading="${i === 0 ? 'eager' : 'lazy'}">
        </div>
      </div>
    </div>
    <div class="book-strip">
      <p class="book-strip-text"></p>
    </div>
  `

  section.querySelector('.book-strip-text').innerHTML = bookData.strip
  document.body.insertBefore(section, artistSection)
})

// ── Timelines de libros ───────────────────────────────────────
books.forEach((_, i) => {
  const section = document.getElementById('book-' + i)
  const bookEl  = section.querySelector('.book')
  const front   = section.querySelector('.book-front')
  const s1      = section.querySelector('.spread-1')
  const s2      = section.querySelector('.spread-2')
  const stripEl = section.querySelector('.book-strip-text')

  const tl = gsap.timeline({
    scrollTrigger: {
      trigger : '#driver-' + i,
      start   : 'top top',
      end     : 'bottom top',
      scrub   : 0.8,
    }
  })

  // Apertura + páginas (igual para todos los libros)
  tl.to(front, { rotateY: -170, duration: 1.2, ease: 'power2.inOut' }, '+=0.4')
  tl.to(s1,    { opacity: 1,    duration: 0.5 },                       '-=0.5')
  tl.to(s1,    { opacity: 0,    duration: 0.4 },                       '+=0.5')
  tl.to(s2,    { opacity: 1,    duration: 0.5 },                       '<+=0.1')

  if (i < lastIndex) {
    // ── Cierra y sale por la IZQUIERDA (simultáneo) ───────────
    // s2 desaparece → la tapa cierra Y el libro se desliza a la vez
    tl.to(s2,      { opacity: 0, duration: 0.4 },                          '+=0.5')
    tl.to(front,   { rotateY: 0, duration: 0.9, ease: 'power2.inOut' },   '+=0.2')
    tl.to(bookEl,  { x: '-130vw', duration: 0.9, ease: 'power2.inOut' },  '<')      // ← mismo instante
    tl.to(section, { opacity: 0, duration: 0.4 },                          '-=0.2')

  } else {
    // ── Último libro: zoom al blanco → Mey ───────────────────
    //
    //  s2 (hermano2.jpeg) tiene mucho blanco. Hacemos zoom sin fade:
    //  la imagen llena la pantalla mostrando el blanco de la ilustración.
    //  La sección (fondo #fff) se disuelve sobre el artist-section
    //  (también blanco) → Mey emerge desde el blanco.
    //
    //  Ajustar transformOrigin según la zona más blanca de hermano2.jpeg:
    //    '50% 50%' = centro | '50% 20%' = zona superior | etc.
    tl.to(s2, {
      scale           : 14,
      transformOrigin : '50% 50%',
      duration        : 1.2,
      ease            : 'power2.in'
    }, '+=0.5')

    tl.to(section, { opacity: 0, duration: 0.6 }, '-=0.6')

    tl.to('.artist-inner', {
      opacity  : 1,
      y        : 0,
      duration : 0.8,
      ease     : 'power2.out'
    }, '-=0.1')

    // Footer aparece después de que Mey termina de aparecer
    tl.to('.site-footer', {
      opacity  : 1,
      y        : 0,
      duration : 0.5,
      ease     : 'power2.out'
    }, '+=0.2')
  }

  // ── Strip de texto: atraviesa de DERECHA a IZQUIERDA ─────────
  // Cubre el 100% de la timeline de forma lineal
  const dur = tl.totalDuration()
  tl.fromTo(stripEl,
    { x: '108vw' },
    { x: '-108vw', ease: 'none', duration: dur },
    0
  )
})

// ── MENÚ ──────────────────────────────────────────────────────

// Poblar lista de libros
const worksList = document.getElementById('works-list')
books.forEach(book => {
  const li  = document.createElement('li')
  const a   = document.createElement('a')
  a.href    = '#'
  a.innerHTML = book.title      // usa innerHTML para soportar <del>
  li.appendChild(a)
  worksList.appendChild(li)
})

// Referencias
const menuBtn     = document.getElementById('menu-btn')
const menuOverlay = document.getElementById('menu-overlay')
const worksToggle = document.getElementById('works-toggle')

// GSAP timeline del overlay (paused, se controla con play/reverse)
const menuAnim = gsap.timeline({ paused: true })
menuAnim
  .to(menuOverlay, { autoAlpha: 1, duration: 0.25, ease: 'power2.out' })
  .from('#menu-nav > li', {
    y       : 28,
    opacity : 0,
    stagger : 0.09,
    duration: 0.35,
    ease    : 'power2.out'
  }, '-=0.05')

// Estado del menú
let menuOpen = false

function openMenu () {
  menuOpen = true
  menuBtn.setAttribute('aria-expanded', 'true')
  menuOverlay.setAttribute('aria-hidden', 'false')
  menuBtn.classList.add('is-open')
  menuAnim.play()
}

function closeMenu () {
  menuOpen = false
  menuBtn.setAttribute('aria-expanded', 'false')
  menuOverlay.setAttribute('aria-hidden', 'true')
  menuBtn.classList.remove('is-open')
  menuAnim.reverse()
}

menuBtn.addEventListener('click', () => menuOpen ? closeMenu() : openMenu())

// Cerrar al hacer click fuera del nav
menuOverlay.addEventListener('click', e => {
  if (e.target === menuOverlay) closeMenu()
})

// Cerrar con Escape
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && menuOpen) closeMenu()
})

// Toggle "Mis trabajos"
worksToggle.addEventListener('click', () => {
  const isOpen = worksList.classList.toggle('open')
  worksToggle.setAttribute('aria-expanded', String(isOpen))
})
