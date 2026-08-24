document.addEventListener('DOMContentLoaded', () => {

    // 1. LÓGICA PARALLAX PARA EL FONDO (Blobs y Luciernagas)
    const fixedBackground = document.getElementById('fixed-background');
    if (fixedBackground) {
        const parallaxSpeed = 0.4;
        let isTicking = false;
        function updateParallax() {
            const scrollY = window.pageYOffset;
            fixedBackground.style.transform = `translateY(${scrollY * parallaxSpeed}px)`;
            isTicking = false;
        }
        window.addEventListener('scroll', () => {
            if (!isTicking) {
                window.requestAnimationFrame(updateParallax);
                isTicking = true;
            }
        });
    }

    // 2. SCROLL SUAVE PARA EL MENÚ Y ENLACES (Offset corregido)
    const menuToggle = document.getElementById('menu-toggle');
    const menuLinks = document.querySelectorAll('.menu-list a, a[href^="#"]');
    menuLinks.forEach(link => {
        link.addEventListener('click', (event) => {
            const targetId = link.getAttribute('href');
            if (targetId && targetId.startsWith('#') && targetId.length > 1) {
                event.preventDefault();
                const targetElement = document.querySelector(targetId);
                if (targetElement) {
                    if (menuToggle && menuToggle.checked) {
                        menuToggle.checked = false;
                    }
                    const header = document.querySelector('.main-header');
                    const headerHeight = header ? header.offsetHeight : 0;
                    const elementPosition = targetElement.getBoundingClientRect().top;
                    const offsetPosition = elementPosition + window.pageYOffset - headerHeight;

                    window.scrollTo({
                        top: offsetPosition,
                        behavior: 'smooth'
                    });
                }
            }
        });
    });

    // 3. APARICIÓN PROGRESIVA (Intersection Observer)
    const elementsToFadeIn = document.querySelectorAll('.fade-in-element');
    const fadeInObserver = new IntersectionObserver((entries, observer) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                entry.target.classList.add('is-visible');
                observer.unobserve(entry.target);
            }
        });
    }, { threshold: 0.1 });
    elementsToFadeIn.forEach(element => fadeInObserver.observe(element));

    // 4. LAZY-LOAD IFRAMES
    // --- Formulario de Consultas: carga individual al acercarse ---
    const consultasIframe = document.querySelector('iframe.lazy-iframe:not(.lazy-iframe-formaciones)');
    if (consultasIframe) {
        const consultasObserver = new IntersectionObserver((entries, observer) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    entry.target.src = entry.target.dataset.src;
                    observer.unobserve(entry.target);
                }
            });
        }, { rootMargin: '300px 0px' });
        consultasObserver.observe(consultasIframe);
    }

    // --- Formularios de Formaciones: cargan todos al llegar a Júpiter ---
    const jupiterSection = document.getElementById('construccion-jupiter');
    if (jupiterSection) {
        const formacionesObserver = new IntersectionObserver((entries, observer) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    document.querySelectorAll('iframe.lazy-iframe-formaciones').forEach(iframe => {
                        if (!iframe.src) iframe.src = iframe.dataset.src;
                    });
                    observer.unobserve(entry.target);
                }
            });
        }, { rootMargin: '200px 0px' });
        formacionesObserver.observe(jupiterSection);
    }

    // 5. EFECTO SHRINK VINCULADO AL SCROLL
    let ticking = false;
    window.addEventListener('scroll', () => {
        if (!ticking) {
            window.requestAnimationFrame(() => {
                const containers = document.querySelectorAll('.efecto-shrink-container');
                containers.forEach(container => {
                    const rect = container.getBoundingClientRect();
                    let progress = -rect.top / (rect.height - window.innerHeight);
                    progress = Math.max(0, Math.min(1, progress));
                    container.style.setProperty('--scroll-progress', progress);
                });
                ticking = false;
            });
            ticking = true;
        }
    });

    // 6. OCULTAR ÍCONO DE SCROLL (SVG flechita) EN CAJAS DE TEXTO
    const scrollableBoxes = document.querySelectorAll('.subsection, .efecto-texto, .formaciones-texto');
    scrollableBoxes.forEach(box => {
        box.addEventListener('scroll', function() {
            box.classList.add('scrolling');
        }, { once: true });
    });

    // 7. NAVEGACIÓN POR FLECHAS (Carruseles PC)
    const contenedoresCarrusel = document.querySelectorAll('.efecto-visual, .formaciones-media');
    contenedoresCarrusel.forEach(contenedor => {
        const carrusel = contenedor.querySelector('.carrusel-horizontal, .carrusel-nativo');
        const flechaIzq = contenedor.querySelector('.flecha-izq');
        const flechaDer = contenedor.querySelector('.flecha-der');

        if (carrusel && flechaIzq && flechaDer) {
            const distanciaScroll = 350;
            flechaIzq.addEventListener('click', () => {
                carrusel.scrollBy({ left: -distanciaScroll, behavior: 'smooth' });
            });
            flechaDer.addEventListener('click', () => {
                carrusel.scrollBy({ left: distanciaScroll, behavior: 'smooth' });
            });
        }
    });

    // 8. ACORDEÓN PARA ELEMENTOS <DETAILS>
    document.querySelectorAll('details').forEach((detail) => {
        detail.addEventListener('toggle', () => {
            if (detail.open) {
                detail.parentElement.querySelectorAll('details').forEach((sibling) => {
                    if (sibling !== detail) sibling.open = false;
                });
            }
        });
    });

});
