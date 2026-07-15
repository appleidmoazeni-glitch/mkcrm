<template>
  <div class="modal fade" id="setComment" tabindex="-1" role="dialog" aria-hidden="true">
    <div class="modal-dialog modal-xl modal-dialog-centered" role="document">
      <div class="modal-content">
        <div class="card chat-app-wrapper">
          <div class="row chat-app">
            <div class="col-12 chat-body">
              <div class="chat-body-header">
                <div>
                  <figure class="avatar avatar-sm m-l-10">
                    <img src="/admin/assets/media/image/avatar-m.jpg" class="rounded-circle" alt="image">
                  </figure>
                </div>
                <div>
                  <h6 class="mb-1 primary-font line-height-18 customer-name"></h6>
                  <span class="small text-muted">
                  شماره سفارش: <span class="order-id"></span> | موبایل: <span class="customer-mobile"></span>
                  </span>
                </div>
                <div class="mr-auto d-flex">
                  <button type="button" class="btn btn-outline-light btn-floating ml-1" id="reloadComments" aria-label="بارگذاری مجدد"><i class="ti-reload"></i></button>
                  <button type="button" class="btn btn-outline-light btn-floating" data-dismiss="modal" aria-label="بستن"><i class="ti-close"></i></button>
                </div>
              </div>
              <b-overlay :show="modalLoading" opacity="0.6" rounded="lg" class="chat-body-messages">
                <div class="message-items"></div>
              </b-overlay>
              <div class="chat-body-footer">
                <form class="d-flex align-items-center">
                  <div class="dropup">
                    <button type="button" data-toggle="dropdown" class="ml-3 btn btn-light btn-floating"><i class="fa fa-bolt text-white"></i></button>
                    <div class="dropdown-menu dropdown-menu-right">
                      <div class="dropdown-menu-body">
                        <ul>
                          <li><a @click.prevent="defaultComment($event)" class="dropdown-item" href="#">منتظر تایید مرجوعی توسط مشتری</a></li>
                          <li><a @click.prevent="defaultComment($event)" class="dropdown-item" href="#">دریافت شماره حساب از مشتری</a></li>
                          <li><a @click.prevent="defaultComment($event)" class="dropdown-item" href="#">در انتظار تامین کال</a></li>
                          <li><a @click.prevent="defaultComment($event)" class="dropdown-item" href="#">در انتظار عودت وجه</a></li>
                          <li><a @click.prevent="defaultComment($event)" class="dropdown-item" href="#">کنسل به علت کسر واریزی</a></li>
                          <li><a @click.prevent="defaultComment($event)" class="dropdown-item" href="#">کنسل به علت عدم تامین کال</a></li>
                          <li><a @click.prevent="defaultComment($event)" class="dropdown-item" href="#">کنسل به علت تغییر رنگ</a></li>
                          <li><a @click.prevent="defaultComment($event)" class="dropdown-item" href="#">کنسل به علت عدم موجودی</a></li>
                          <li><a @click.prevent="defaultComment($event)" class="dropdown-item" href="#">کنسب به علت عدم تایید درگاه</a></li>
                          <li><a @click.prevent="defaultComment($event)" class="dropdown-item" href="#">تایید دستی به علت عدم تایید درگاه</a></li>
                          <li><a @click.prevent="defaultComment($event)" class="dropdown-item" href="#">تماس بدون پاسخ با مشتری</a></li>
                          <li><a @click.prevent="defaultComment($event)" class="dropdown-item" href="#">عدم امکان پرداخت درب منزل</a></li>
                          <li><a @click.prevent="defaultComment($event)" class="dropdown-item" href="#">انصراف از خرید</a></li>
                          <li><a @click.prevent="defaultComment($event)" class="dropdown-item" href="#">خرید انجام شده است</a></li>
                          <li><a @click.prevent="defaultComment($event)" class="dropdown-item" href="#">بی پاسخ</a></li>
                          <div class="dropdown-divider"></div>
                          <li><a @click.prevent="defaultComment($event)" class="dropdown-item" href="#">خطای عملیات بانکی</a></li>
                          <li><a @click.prevent="defaultComment($event)" class="dropdown-item" href="#">خرید به صورت اقساطی</a></li>
                          <li><a @click.prevent="defaultComment($event)" class="dropdown-item" href="#">خرید از رقبا</a></li>
                          <li><a @click.prevent="defaultComment($event)" class="dropdown-item" href="#">عدم اطلاعات کافی و نیاز به مشاوره</a></li>
                          <li><a @click.prevent="defaultComment($event)" class="dropdown-item" href="#">قیمت بالای محصول</a></li>
                          <li></li>
                        </ul>
                      </div>
                    </div>
                  </div>

                  <input @keypress.enter.prevent="" id="commentText" type="text" class="form-control" placeholder="متن پیامتون رو وارد کنید ...">
                  <div class="d-flex">
                    <button @click="sendComment" type="button" id="sendComment" class="mr-3 btn btn-primary btn-floating"><i class="ti-receipt"></i></button>
                    <div class="dropup">
                      <button type="button" data-toggle="dropdown" class="mr-3 btn btn-success btn-floating"><i class="fa fa-plus"></i></button>
                      <div class="dropdown-menu dropdown-menu-left">
                        <div class="dropdown-menu-body">
                          <ul>
                            <li><a @click.prevent="commentType='sms'" class="dropdown-item" href="#"><i class="icon ti-comment-alt"></i> پیامک</a></li>
                            <li><a @click.prevent="commentType='user'" class="dropdown-item" href="#"><i class="icon ti-user"></i> نمایش به مشتری</a></li>
                            <li><a @click.prevent="commentType='system'" class="dropdown-item" href="#"><i class="icon ti-receipt"></i> سیستمی</a></li>
                          </ul>
                        </div>
                      </div>
                    </div>
                  </div>
                </form>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script>
import axios from "axios";

export default {
  name: "ModalComment",
  data(){
    return {
      modalLoading: true,
      commentType: 'system'
    }
  },
  props: ['ordersList'],
  methods: {
    defaultComment(el){
      document.getElementById('commentText').value = el.target.innerText;
      $(".dropdown-menu").removeClass('show');
    },
    sendComment(){
      if( this.commentType == "system" || this.commentType == "user" || this.commentType == "sms" ){
        let note = document.getElementById('commentText').value;
        document.getElementById('commentText').value = "";
        axios.post('/admin/products/orders.comments', {
          id: this.ordersList[this.activeIndex].id,
          type: this.commentType,
          note: note
        }).then(({data}) => {
          if( data.ok ){
            $('#setComment').find('#reloadComments').click();
          }else{
            toastr['error'](data.error);
          }
        });
      }else{
        toastr['error']("خطای عملیاتی");
      }
    },
    setComment(){
      axios.put('/admin/products/ordersList.setComment', $("#setComment form").serialize()).then(({data}) => {
        if( data.ok ) {
          toastr['success'](data.msg);
          this.ordersList[this.activeIndex].admincomment = $("#setComment form [name=admincomment]").val();
          $('#setComment').modal('hide');
        }else{
          toastr['error'](data.error);
        }
      });
    },
    translateStatus(str){
      str = str.replace('Order placed', "سفارش ثبت شد");
      str = str.replace('Order has been marked as paid', "سفارش پرداخت شد");
      str = str.replace('Order status has been changed to Processing', "وضعیت سفارش به <strong class='text-bolder'>درحال پردازش</strong> تغییر کرد");
      str = str.replace('Order status has been edited. New status:', "وضعیت سفارش تغییر کرد به:");
      return str;
    }
  },
  watch:{
    commentType: {
      handler: function (value){
        switch (value){
          case "sms":
            $("#sendComment").removeClass('btn-primary btn-warning btn-success').addClass('btn-warning');
            $("#sendComment i").attr('class', "ti-comment-alt");
            $(".dropdown-menu").removeClass('show');
            break;
          case "user":
            $("#sendComment").removeClass('btn-primary btn-warning btn-success').addClass('btn-success');
            $("#sendComment i").attr('class', "ti-user");
            $(".dropdown-menu").removeClass('show');
            break;
          case "system":
            $("#sendComment").removeClass('btn-primary btn-warning btn-success').addClass('btn-primary');
            $("#sendComment i").attr('class', "ti-receipt");
            $(".dropdown-menu").removeClass('show');
            break;
        }
      }
    }
  },
  created() {
    const vm = this;
    $(function (){
      $('#setComment').on('show.bs.modal', function (event) {
        var btn = $(event.relatedTarget), modal = $(this), i = btn.data('index');

        if( vm.ordersList[i].lastname ){
          modal.find('.order-id').parent().show();
          modal.find('.customer-name').text(vm.ordersList[i].lastname);
          modal.find('.order-id').text(vm.ordersList[i].id);
          modal.find('.customer-mobile').text(vm.ordersList[i].PhoneNumber);
        }else{
          modal.find('.order-id').parent().hide();
          modal.find('.customer-name').text('شماره سفارش: ' + vm.ordersList[i].id);
        }

        modal.find('#commentText').val('');
        vm.activeIndex = i;
        vm.commentType='system';

        modal.find('#reloadComments').off('click');
        modal.find('#reloadComments').click(function (){
          vm.modalLoading = true;
          let story = {};
          let messageItems = modal.find('.message-items');
          messageItems.html('');
          axios.get('/admin/products/notes', {params: {id: vm.ordersList[i].id}}).then(({data}) => {
            if( data.ok ){
              vm.commentType='system';
              for( let note of data.notes ){
                let date = new Date(note.CreatedOnUtc);
                if( story[date.echoFa("Y/m/d")] ){
                  story[date.echoFa("Y/m/d")].push(note);
                }else{
                  story[date.echoFa("Y/m/d")] = [note];
                }
              }

              for(let day in story){
                let date = day;
                if( day == new Date().echoFa('Y/m/d') ) date = "امروز";
                else if( day == new Date(new Date().setDate(new Date().getDate()-1)).echoFa("Y/m/d") ) date = "دیروز";

                messageItems.append('<div class="message-item message-item-date-border"><span class="badge">'+date+'</span></div>')
                for(let note of story[day]){
                  if( note.Systematic == 1 ){
                    messageItems.append(`<div class="message-item message-system"><span class="badge">${vm.translateStatus(note.Note)}<small class="message-item-date text-muted">${(new Date(note.CreatedOnUtc).echoFa('H:i'))}</small></span></div>`);
                  }else{
                    if( note.Username == vm.$store.state.user.mobile ){
                      messageItems.append('<div class="message-item '+(note.Systematic==2 ? 'bg-warning' : (note.DisplayToCustomer?'bg-success':''))+'">' + note.Note +
                          '<small class="message-item-date text-muted">'+(new Date(note.CreatedOnUtc).echoFa('H:i'))+'</small><span class="mi-actions" data-id="'+note.Id+'"><i class="fa fa-star '+(note.stared?'text-warning':'text-muted')+'"></i> <i class="fa fa-trash text-danger"></i></span></div>');
                    } else {
                      messageItems.append('<div class="message-item '+(note.Systematic==2 ? 'bg-warning' : (note.DisplayToCustomer?'bg-success':''))+' outgoing-message m-l-45">\n' +
                          (note.avatar ? '<figure className="avatar avatar-state-success avatar-sm"><img src="/'+note.avatar+'" class="avatar-sm-img rounded-circle" alt="image"></figure>' : '<figure class="avatar avatar-sm"><span class="avatar-title bg-danger rounded-circle">'+note.FirstName.substring(0, 1)+"‌"+note.LastName.substring(0, 1)+'</span></figure>') +
                          note.Note +
                          '<small class="message-item-date text-muted">'+(new Date(note.CreatedOnUtc).echoFa('H:i'))+'</small><span class="mi-actions" data-id="'+note.Id+'"><i class="fa fa-star '+(note.stared?'text-warning':'text-muted')+'"></i></span></div>')
                    }
                  }
                }
              }

              setTimeout(function (){
                $(".chat-body-messages").scrollTop($('.chat-body-messages').get(0).scrollHeight, -1).niceScroll({railalign: "left"});
                vm.modalLoading = false;
              }, 5);
            }else{
              vm.modalLoading = false;
            }

          });
        });
        modal.find('#reloadComments').click();

      });
      $("#setComment").on('click', ".mi-actions .fa-star", function(){
        let id = $(this).parent().data('id'),
            oid = vm.ordersList[vm.activeIndex].id,
            stared = $(this).hasClass('text-warning') ? 0:1,
            t = $(this);
        axios.put('/admin/products/orders.comments', {id, oid, stared}).then(({data}) => {
          if( data.ok ){
            t.removeClass('text-warning text-muted');
            if( stared ) t.addClass('text-warning');
            else t.addClass('text-muted');
            vm.ordersList[vm.activeIndex].admincomment = data.comment;

          }else{
            toastr['error']("خطای عملیاتی");
          }
        });
      });
      $("#setComment").on('click', ".mi-actions .fa-trash", function(){
        let id = $(this).parent().data('id');
        axios.delete('/admin/products/orders.comments', {params: {id: id}}).then(({data}) => {
          if( data.ok ){
            $('#reloadComments').click();
            vm.ordersList[vm.activeIndex].admincomment = data.comment;
            toastr['success']("کامنت مورد نظر با موفقیت حذف شد.");

          }else{
            toastr['error']("خطای عملیاتی");
          }
        });
      });
    });
  }
}
</script>

<style>
.message-item .mi-actions {
  position: absolute;
  margin-right: 18px;
  margin-top: 9px;
  display: inline-flex;
}
.message-item .mi-actions *{cursor: pointer;}
.message-item .mi-actions .fa-star{opacity: 0;transition: opacity 0.5s 1s;}
.message-item .mi-actions .fa-star[class*=text-warning]{opacity: 1;transition: opacity 0.5s;}
.message-item:hover .mi-actions .fa-star {opacity: 1;transition: opacity 0.5s;}

.message-item .mi-actions .fa-trash{opacity: 0;transition: opacity 0.5s 1s; margin-right: 4px;}
.message-item .mi-actions .fa-trash[class*=text-warning]{opacity: 1;transition: opacity 0.5s;}
.message-item:hover .mi-actions .fa-trash {opacity: 1;transition: opacity 0.5s;}

.message-item.outgoing-message .mi-actions {right: 0;margin-right: -18px;}
.message-item.outgoing-message figure {
  position: absolute;
  left: -40px;
}
.message-system{
  background: #e1e1e1 !important;
  width: 100% !important;
  max-width: 100% !important;
  height: 0;
  padding: 0 !important;
  margin: 5px 0;
  margin-bottom: 20px !important;
}
.message-system .badge{
  display: table;
  margin: auto;
  margin-top: -8px;
  color: #000;
  background: #e1e1e1;
  font-weight: 500;
  padding: 4px 7px;
  letter-spacing: 0.5px;
  position: relative;
}

.chat-app-wrapper .chat-app .chat-body .chat-body-messages .message-items .message-item .message-item-date {
  right: 10px;
}
.message-system .message-item-date{
  bottom: 0 !important;
  left: -24px !important;
  font-size: 8px !important;
  right: inherit !important;
}
.avatar-sm-img{width: 36.8px;}
</style>
