// Quienes egresaron de la formacion completa (4 anos).
//
// Esta lista es lo unico que hay que tocar para agregar a alguien. El orden no
// importa: la pagina los ordena sola por nombre, sin separar por ano.
//
// Lo unico obligatorio es el nombre, escrito igual que en el titulo. Todo lo
// demas es el perfil, y va SOLO si la persona lo mando y quiere que se publique:
// son datos de contacto, no se completan por nuestra cuenta. Quien no tenga
// perfil aparece igual en la lista, con el nombre solo.
//
//   nombre     Nombre y apellido, como figura en el titulo.
//   foto       Archivo dentro de img/ (cuadrada, 400x400, .webp). Opcional.
//   donde      Ciudad o "A distancia". Opcional.
//   bio        Una o dos lineas: que ofrece, como trabaja. Opcional.
//   whatsapp   Solo numeros, con pais y sin el 0 ni el 15: 5491122334455.
//   mail       Para el boton de mail.
//   instagram  El usuario, sin arroba.
//   web        URL completa, con https://
//
// Mas adelante, cuando haya certificados de los cursos sueltos, cada uno va a
// tener su propia pagina colgando de aca (/escuela/egresadxs/<curso>/) con su
// propia lista. Esta queda para la formacion completa.

window.EGRESADXS = [
    { nombre: "Aimé Percincula" },
    { nombre: "Anabella De Grazia" },
    { nombre: "Camelia Rud" },
    { nombre: "Florencia Dyszel" },
    { nombre: "Florencia Rodriguez Cheula" },
    { nombre: "Lila Vrinda Rubi" },
    { nombre: "Lucia Miglietta" },
    { nombre: "María Gabriela Luppi" },
    { nombre: "Ramiro Furió Boffa" },
    { nombre: "Rosanna Girini" },
    { nombre: "Sol Brunello" },
];
