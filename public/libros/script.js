// Se envuelve todo en un único listener para asegurar que la página esté cargada.
document.addEventListener('DOMContentLoaded', () => {

    // --- LÓGICA PARALLAX PARA EL FONDO ---
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

    // --- LÓGICA DE SCROLL SUAVE PARA EL MENÚ Y ENLACES ---
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

    // --- LÓGICA DEL CARRUSEL ---
    const carouselContainers = document.querySelectorAll('.carousel-container');
    carouselContainers.forEach(container => {
        const carouselTrack = container.querySelector('.carousel-track');
        if (!carouselTrack) return;
        const prevButton = container.querySelector('.carousel-button.prev');
        const nextButton = container.querySelector('.carousel-button.next');
        const items = container.querySelectorAll('.carousel-item');
        if (items.length <= 1) {
            if(prevButton) prevButton.style.display = 'none';
            if(nextButton) nextButton.style.display = 'none';
            return;
        }
        let currentIndex = 0;
        const slideIntervalTime = 4000;
        let slideInterval;
        const updateCarousel = () => {
            if (items[0]) {
                const slideDistance = items[0].offsetWidth;
                carouselTrack.style.transform = `translateX(${-currentIndex * slideDistance}px)`;
            }
        };
        const startAutoslide = () => {
            slideInterval = setInterval(() => {
                currentIndex = (currentIndex < items.length - 1) ? currentIndex + 1 : 0;
                updateCarousel();
            }, slideIntervalTime);
        };
        const resetAutoslide = () => { clearInterval(slideInterval); startAutoslide(); };
        if(prevButton) prevButton.addEventListener('click', () => { currentIndex = (currentIndex > 0) ? currentIndex - 1 : items.length - 1; updateCarousel(); resetAutoslide(); });
        if(nextButton) nextButton.addEventListener('click', () => { currentIndex = (currentIndex < items.length - 1) ? currentIndex + 1 : 0; updateCarousel(); resetAutoslide(); });
        updateCarousel();
        startAutoslide();
        document.addEventListener('visibilitychange', () => document.hidden ? clearInterval(slideInterval) : startAutoslide());
    });

    // --- LÓGICA: APARICIÓN PROGRESIVA AL HACER SCROLL ---
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

    // --- LÓGICA PARA OCULTAR ÍCONO DE SCROLL EN CAJAS DE TEXTO ---
    const scrollableBoxes = document.querySelectorAll('.subsection');
    scrollableBoxes.forEach(box => {
        box.addEventListener('scroll', function() {
            box.classList.add('scrolling');
        }, { once: true });
    });
// --- LÓGICA DEL BOTÓN COPIAR (CBU/ALIAS) ---
    document.querySelectorAll('.copy-btn').forEach(button => {
        button.addEventListener('click', function() {
            const targetId = this.getAttribute('data-target');
            // Usamos .textContent para obtener solo el texto visible
            const textToCopy = document.getElementById(targetId).textContent.trim(); 
            
            // Uso de la API del Portapapeles (moderno y recomendado)
            navigator.clipboard.writeText(textToCopy).then(() => {
                const messageElement = document.getElementById('copy-message');
                // Mostramos el mensaje de éxito
                messageElement.textContent = `¡${targetId.toUpperCase().replace('-VALUE', '')} copiado con éxito!`;
                messageElement.style.display = 'block'; 
                
                // Oculta el mensaje después de 2.5 segundos
                setTimeout(() => {
                    messageElement.style.display = 'none';
                }, 2500);
                
            }).catch(err => {
                console.error('Error al copiar: ', err);
                alert('Error al intentar copiar. Por favor, cópialo manualmente.');
            });
        });
    });
    // --- LÓGICA DE LA VENTANA MODAL (PDF PREVIEW) ---
const pdfModal = document.getElementById('pdf-modal');
const openPreviewBtn = document.getElementById('open-preview-btn');
const closeBtn = document.querySelector('.close-btn');

if (openPreviewBtn && pdfModal && closeBtn) {
    openPreviewBtn.onclick = function() {
        pdfModal.style.display = 'block';
    }
    closeBtn.onclick = function() {
        pdfModal.style.display = 'none';
    }
    // Cierra si el usuario hace click fuera de la modal
    window.onclick = function(event) {
        if (event.target == pdfModal) {
            pdfModal.style.display = 'none';
        }
    }
}

});